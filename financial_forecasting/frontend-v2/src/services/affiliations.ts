import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface AccountsWithFellowsResponse {
  fellow_account_ids: string[];
  pbc_account_ids: string[];
  affiliation_available: boolean;
}

export interface Fellow {
  affiliation_id: string | null;
  contact_id: string | null;
  name: string | null;
  title: string | null;
  email: string | null;
  photo_url: string | null;
  role: string | null;
  status: string | null;
  start_date: string | null;
}

export interface FellowsResponse {
  data: Fellow[];
  available: boolean;
}

export function useAccountsWithFellows() {
  return useQuery({
    queryKey: ["accounts-with-fellows"],
    queryFn: async () => {
      const { data } = await api.get<AccountsWithFellowsResponse>(
        "/api/salesforce/accounts/with-fellows",
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useFellowsForAccount(accountId: string | undefined) {
  return useQuery({
    queryKey: ["fellows-for-account", accountId],
    queryFn: async () => {
      const { data } = await api.get<FellowsResponse>(
        `/api/salesforce/accounts/${accountId}/fellows`,
      );
      return data;
    },
    enabled: !!accountId,
    staleTime: 60_000,
  });
}
