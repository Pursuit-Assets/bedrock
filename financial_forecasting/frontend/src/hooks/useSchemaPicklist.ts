/**
 * React Query hook for any Salesforce picklist field.
 *
 * Backed by `GET /api/salesforce/schema/:sobject`. Reads the `fields` array
 * from the describe response, finds the named field, and extracts its active
 * picklist values as a sorted, deduped string list. All callers sharing the
 * same `(sobject, fieldName)` pair share one 30-minute cache entry so the
 * SF schema describe fetch dedupes to a single network call per field per
 * window.
 *
 * Response shape (from `routes/salesforce_schema.py:_slim_field`):
 *   {
 *     sobject: string,
 *     fields: Array<{
 *       name: string,
 *       label?: string,
 *       type?: 'picklist' | 'multipicklist' | 'reference' | ...,
 *       picklistValues?: Array<{ value: string, label: string, active: boolean }>,
 *       ...
 *     }>,
 *     recordTypes: [...],
 *     ...
 *   }
 *
 * Graceful degradation: on error, while loading, when the named field is
 * absent from the describe response, when the field has no `picklistValues`
 * (e.g., text/currency fields), or when every value is inactive — the hook
 * returns an empty `options` array. Consumers should detect the empty case
 * and fall back to a disabled select or a free-text input so the UI does
 * not hard-fail when Salesforce is unreachable or the schema endpoint 500s.
 */
import { useMemo } from 'react';
import { useQuery } from 'react-query';
import { apiService } from '../services/api';

interface PicklistValue {
  value: string;
  label: string;
  active: boolean;
}

interface SchemaField {
  name: string;
  label?: string;
  type?: string;
  picklistValues?: PicklistValue[];
}

const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes — SF picklists change rarely

export interface UseSchemaPicklistResult {
  /** Sorted, deduped list of active picklist values. Empty when unavailable. */
  options: string[];
  isLoading: boolean;
  error: unknown;
}

export function useSchemaPicklist(
  sobject: string,
  fieldName: string,
): UseSchemaPicklistResult {
  const { data, isLoading, error } = useQuery(
    ['schema-picklist', sobject, fieldName] as const,
    async () => {
      const res = await apiService.getSchemaDescribe(sobject);
      // Defensive envelope access: current backend returns raw
      // `{ fields, recordTypes, ... }`, but historical callers have also
      // seen `{ success, data: { fields, ... } }`. Both shapes resolve.
      const fields: SchemaField[] =
        res.data?.data?.fields ?? res.data?.fields ?? [];
      const field = fields.find((f) => f.name === fieldName);
      if (!field || !Array.isArray(field.picklistValues)) return [];
      // Only surface active values. Deduplicate defensively — the SF describe
      // endpoint shouldn't return duplicates, but upstream changes to the
      // slim-field projection could introduce them.
      const seen = new Set<string>();
      const result: string[] = [];
      for (const pv of field.picklistValues) {
        if (!pv?.active || !pv?.value) continue;
        if (seen.has(pv.value)) continue;
        seen.add(pv.value);
        result.push(pv.value);
      }
      return result.sort();
    },
    {
      staleTime: STALE_TIME_MS,
      retry: 1,
    },
  );

  const options = useMemo(() => data ?? [], [data]);

  return { options, isLoading, error };
}
