import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { apiService } from '../services/api';
import type { OwnerGoal } from '../config/goals';

/** Extract backend error detail or fall back to a default message. */
function errMsg(err: unknown, fallback: string): string {
  const detail = (err as any)?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

const queryKey = (fiscalYear: number) => ['owner-goals', fiscalYear];

/**
 * React Query hook for per-owner annual revenue goals.
 *
 * Returns:
 *  - `goals`: Record<sfUserId, OwnerGoal> for the requested fiscal year
 *  - `isLoading`, `error`: query state
 *  - `upsertGoal(sfUserId, amount, notes?)`: mutation that upserts a goal
 *  - `deleteGoal(sfUserId)`: mutation that removes a goal (revert to default)
 *  - `isMutating`: true while any write is in flight
 */
export function useOwnerGoals(fiscalYear: number) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery(
    queryKey(fiscalYear),
    async () => {
      const res = await apiService.getOwnerGoals(fiscalYear);
      // Backend wraps under {success, data: {sfUserId: OwnerGoal}}
      const payload = (res.data?.data ?? res.data ?? {}) as Record<string, OwnerGoal>;
      return payload;
    },
    {
      staleTime: 60_000,
      retry: 1,
    },
  );

  const goals: Record<string, OwnerGoal> = useMemo(() => data || {}, [data]);

  const upsertMutation = useMutation(
    ({ sfUserId, goalAmount, notes }: { sfUserId: string; goalAmount: number; notes?: string }) =>
      apiService.upsertOwnerGoal(sfUserId, {
        fiscal_year: fiscalYear,
        goal_amount: goalAmount,
        notes: notes ?? '',
      }),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(queryKey(fiscalYear));
        toast.success('Goal updated');
      },
      onError: (err) => {
        toast.error(errMsg(err, 'Failed to update goal'));
      },
    },
  );

  const deleteMutation = useMutation(
    (sfUserId: string) => apiService.deleteOwnerGoal(sfUserId, fiscalYear),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(queryKey(fiscalYear));
        toast.success('Goal reset to default');
      },
      onError: (err) => {
        toast.error(errMsg(err, 'Failed to reset goal'));
      },
    },
  );

  return {
    goals,
    isLoading,
    error,
    refetch,
    upsertGoal: (sfUserId: string, goalAmount: number, notes?: string) =>
      upsertMutation.mutateAsync({ sfUserId, goalAmount, notes }),
    deleteGoal: (sfUserId: string) => deleteMutation.mutateAsync(sfUserId),
    isMutating: upsertMutation.isLoading || deleteMutation.isLoading,
  };
}
