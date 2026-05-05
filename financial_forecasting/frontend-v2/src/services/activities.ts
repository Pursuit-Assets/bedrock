import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { BedrockActivity } from "@/types/salesforce";

export interface ActivityFilters {
  opportunityId?: string;
  accountId?: string;
  contactId?: string;
  /** Backend filter on `bedrock.activity.owner_id` (Salesforce User ID). */
  ownerId?: string;
  limit?: number;
}

interface ActivitiesResponse {
  success: boolean;
  data: BedrockActivity[];
  meta?: { total?: number; limit?: number; offset?: number };
}

async function fetchActivities(
  filters: ActivityFilters,
): Promise<BedrockActivity[]> {
  const params = new URLSearchParams();
  if (filters.opportunityId) params.set("opportunity_id", filters.opportunityId);
  if (filters.accountId) params.set("account_id", filters.accountId);
  if (filters.contactId) params.set("contact_id", filters.contactId);
  if (filters.ownerId) params.set("owner_id", filters.ownerId);
  params.set("limit", String(filters.limit ?? 50));
  const { data } = await api.get<ActivitiesResponse>(
    `/api/activities/?${params.toString()}`,
  );
  return data.data ?? [];
}

export function useActivities(filters: ActivityFilters) {
  return useQuery({
    queryKey: ["activities", filters],
    queryFn: () => fetchActivities(filters),
    staleTime: 30_000,
    enabled: !!(
      filters.opportunityId ||
      filters.accountId ||
      filters.contactId ||
      filters.ownerId
    ),
  });
}

async function fetchAccountFullActivities(
  accountId: string,
  limit: number,
): Promise<BedrockActivity[]> {
  const { data } = await api.get<ActivitiesResponse>(
    `/api/activities/account/${encodeURIComponent(accountId)}/full?limit=${limit}`,
  );
  return data.data ?? [];
}

export function useAccountFullActivities(
  accountId: string | undefined,
  limit = 100,
) {
  return useQuery({
    queryKey: ["activities-full", accountId, limit],
    queryFn: () => fetchAccountFullActivities(accountId!, limit),
    staleTime: 30_000,
    enabled: !!accountId,
  });
}
