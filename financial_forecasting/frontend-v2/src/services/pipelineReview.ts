import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type OpportunityChangeField =
  | "StageName"
  | "Amount"
  | "Probability"
  | "CloseDate"
  | string;

export interface OpportunityChange {
  field: OpportunityChangeField;
  from: unknown;
  to: unknown;
  at: string;
  by_name: string | null;
  by_id: string | null;
}

export interface OpportunityChangeRow {
  opportunity_id: string;
  name: string;
  account_id: string | null;
  account_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  stage_name: string | null;
  amount: number | null;
  probability: number | null;
  close_date: string | null;
  last_change_at: string | null;
  changes: OpportunityChange[];
}

interface ChangesResponse {
  success: boolean;
  data: OpportunityChangeRow[];
}

/** Recent opportunity changes from OpportunityFieldHistory. One row
 *  per opp, with all of that opp's StageName / Amount / Probability /
 *  CloseDate changes in the window grouped underneath. */
export function useOpportunityChanges(opts: {
  days?: number;
  ownerId?: string | null;
} = {}) {
  const { days = 7, ownerId = null } = opts;
  const qs = new URLSearchParams();
  qs.set("days", String(days));
  if (ownerId) qs.set("owner_id", ownerId);
  return useQuery({
    queryKey: ["pipeline-review", "changes", days, ownerId],
    queryFn: async () => {
      const { data } = await api.get<ChangesResponse>(
        `/api/pipeline-review/opportunity-changes?${qs.toString()}`,
      );
      return data.data ?? [];
    },
    staleTime: 60_000,
  });
}
