/**
 * React Query hook for the Salesforce Opportunity Record Type list.
 *
 * Backed by the same /api/salesforce/schema/Opportunity endpoint as
 * useOpportunityTypePicklist — SF returns `recordTypeInfos` alongside fields,
 * and we surface those via a separate cache key so the data is easy to reason
 * about in DevTools even though the network call is deduped.
 *
 * Response shape (extended in routes/salesforce_schema.py for BUG-UI-9):
 *   {
 *     success: true,
 *     data: {
 *       fields: [...],
 *       recordTypes: Array<{
 *         id: string,            // Salesforce RecordTypeId (18-char)
 *         name: string,          // User-facing label (e.g. "Philanthropy")
 *         developerName: string,
 *         available: boolean,    // Whether current user can assign this type
 *         defaultRecordTypeMapping: boolean,
 *         master: boolean,       // Should always be false (filtered in backend)
 *       }>
 *     }
 *   }
 *
 * Graceful degradation: on error or while loading, returns an empty options
 * array. Callers should fall back to a read-only display if empty.
 */
import { useMemo } from 'react';
import { useQuery } from 'react-query';
import { apiService } from '../services/api';

interface RecordTypeInfo {
  id: string;
  name: string;
  developerName?: string;
  available?: boolean;
  defaultRecordTypeMapping?: boolean;
  master?: boolean;
}

export interface RecordTypeOption {
  id: string;
  name: string;
}

const QUERY_KEY = ['opportunity-record-types'] as const;
const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes — record types change rarely

export interface UseOpportunityRecordTypesResult {
  /** Record types the current user is allowed to assign. */
  options: RecordTypeOption[];
  isLoading: boolean;
  error: unknown;
}

export function useOpportunityRecordTypes(): UseOpportunityRecordTypesResult {
  const { data, isLoading, error } = useQuery(
    QUERY_KEY,
    async () => {
      const res = await apiService.getSchemaDescribe('Opportunity');
      const raw: RecordTypeInfo[] =
        res.data?.data?.recordTypes ?? res.data?.recordTypes ?? [];
      // Only surface types the user can actually assign; skip any stray master.
      const seen = new Set<string>();
      const result: RecordTypeOption[] = [];
      for (const rt of raw) {
        if (!rt?.id || !rt?.name) continue;
        if (rt.master) continue;
        if (rt.available === false) continue;
        if (seen.has(rt.id)) continue;
        seen.add(rt.id);
        result.push({ id: rt.id, name: rt.name });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    },
    {
      staleTime: STALE_TIME_MS,
      retry: 1,
    },
  );

  const options = useMemo(() => data ?? [], [data]);

  return { options, isLoading, error };
}
