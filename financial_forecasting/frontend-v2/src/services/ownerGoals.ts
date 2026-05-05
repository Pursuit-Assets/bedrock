import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface OwnerGoal {
  sf_user_id: string;
  fiscal_year: number;
  goal_amount: number;
  notes: string;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface OwnerGoalListResponse {
  success: boolean;
  /** Backend returns a dict keyed by sf_user_id, not an array. */
  data: Record<string, OwnerGoal>;
}

interface OwnerGoalSingleResponse {
  success: boolean;
  data: OwnerGoal;
}

const currentFY = () => new Date().getUTCFullYear();

async function fetchOwnerGoals(fiscalYear: number): Promise<OwnerGoal[]> {
  const { data } = await api.get<OwnerGoalListResponse>(
    `/api/owner-goals?fiscal_year=${fiscalYear}`,
  );
  // Endpoint returns `{ success, data: { sf_user_id: {…} } }`. Flatten
  // to an array — most callers iterate, and lookup-by-id is a one-line
  // Map() at the call site when needed.
  return Object.values(data?.data ?? {});
}

export function useOwnerGoals(fiscalYear: number = currentFY()) {
  return useQuery({
    queryKey: ["owner-goals", fiscalYear],
    queryFn: () => fetchOwnerGoals(fiscalYear),
    staleTime: 60_000,
  });
}

export function useUpsertOwnerGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      sf_user_id: string;
      fiscal_year: number;
      goal_amount: number;
      notes?: string;
    }) => {
      const { data } = await api.put<OwnerGoalSingleResponse>(
        `/api/owner-goals/${encodeURIComponent(vars.sf_user_id)}`,
        {
          fiscal_year: vars.fiscal_year,
          goal_amount: vars.goal_amount,
          notes: vars.notes ?? "",
        },
      );
      return data.data;
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["owner-goals", vars.fiscal_year] });
    },
  });
}

export function useDeleteOwnerGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { sf_user_id: string; fiscal_year: number }) => {
      await api.delete(
        `/api/owner-goals/${encodeURIComponent(vars.sf_user_id)}?fiscal_year=${vars.fiscal_year}`,
      );
      return vars;
    },
    onSettled: (_data, _err, vars) => {
      if (vars) {
        void qc.invalidateQueries({ queryKey: ["owner-goals", vars.fiscal_year] });
      }
    },
  });
}
