/**
 * React Query hook for the Salesforce `Opportunity.Type` picklist values.
 *
 * Used by the `TypeCell` inline-edit component (grid), the `OpportunityEditDialog`
 * (full-edit drawer), and anywhere else we need to offer a Type dropdown. All
 * callers share the same queryKey so the SF schema describe fetch dedupes to a
 * single network call per 30-minute window.
 *
 * Response shape (from `routes/salesforce_schema.py:_slim_field`):
 *   {
 *     success: true,
 *     data: {
 *       fields: Array<{
 *         name: string,
 *         label: string,
 *         type: 'picklist' | 'multipicklist' | 'reference' | ...,
 *         picklistValues?: Array<{ value: string, label: string, active: boolean }>,
 *         ...
 *       }>
 *     }
 *   }
 *
 * Graceful degradation: on error OR while still loading, returns an empty
 * `options` array. Consumers should detect the empty case and fall back to
 * a read-only display or a free-text input so the UI doesn't hard-fail when
 * Salesforce is unreachable or the schema endpoint 500s.
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

const QUERY_KEY = ['opportunity-type-picklist'] as const;
const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes — SF picklists change rarely

export interface UseOpportunityTypePicklistResult {
  /** Sorted, deduped list of active picklist values for Opportunity.Type. */
  options: string[];
  isLoading: boolean;
  error: unknown;
}

export function useOpportunityTypePicklist(): UseOpportunityTypePicklistResult {
  const { data, isLoading, error } = useQuery(
    QUERY_KEY,
    async () => {
      const res = await apiService.getSchemaDescribe('Opportunity');
      const fields: SchemaField[] =
        res.data?.data?.fields ?? res.data?.fields ?? [];
      const typeField = fields.find((f) => f.name === 'Type');
      if (!typeField || !Array.isArray(typeField.picklistValues)) return [];
      // Only surface active values. Deduplicate defensively — the SF describe
      // endpoint shouldn't return duplicates, but upstream changes to the
      // slim-field projection could introduce them.
      const seen = new Set<string>();
      const result: string[] = [];
      for (const pv of typeField.picklistValues) {
        if (!pv.active || !pv.value) continue;
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
