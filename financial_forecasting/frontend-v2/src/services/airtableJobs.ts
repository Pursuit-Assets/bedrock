import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Generic Airtable record returned by the bridge. Fields vary by table —
 *  callers narrow as needed at the call site. */
export interface AirtableRecord {
  id: string;
  [field: string]: unknown;
}

export interface AirtableResponse {
  data: AirtableRecord[];
  configured: boolean;
  error?: string;
}

type Tab = "companies" | "postings" | "engagements" | "deals";

function useAirtableTable(table: Tab) {
  return useQuery({
    queryKey: ["airtable-jobs", table],
    queryFn: async () => {
      const { data } = await api.get<AirtableResponse>(
        `/api/airtable/jobs/${table}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export const useAirtableCompanies   = () => useAirtableTable("companies");
export const useAirtableJobs        = () => useAirtableTable("postings");
export const useAirtableEngagements = () => useAirtableTable("engagements");
export const useAirtableDeals       = () => useAirtableTable("deals");
