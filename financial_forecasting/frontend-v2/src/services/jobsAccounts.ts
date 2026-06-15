import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ActivityEntry } from "@/services/jobs";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AccountGroupContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface AccountGroup {
  account: string;
  contact_count: number;
  contacts: AccountGroupContact[];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * GET /api/jobs/contacts/by-account → AccountGroup[]
 * Prospects grouped by account, already ordered by contact_count desc.
 */
export function useAccountsByAccount() {
  return useQuery<AccountGroup[]>({
    queryKey: ["jobs", "contacts-by-account"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<AccountGroup[]>>(
        "/api/jobs/contacts/by-account",
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

export type ProspectActivityType = "call" | "text" | "linkedin";

export interface ProspectActivityBody {
  contact_id: number;
  type: ProspectActivityType;
  description: string;
}

/**
 * POST /api/jobs/activity with a contact-scoped activity.
 * The backend accepts contact_id (type ∈ call|text|linkedin) and links the
 * activity to the contact rather than a deal. Invalidates the contact detail
 * query so the timeline refreshes.
 */
export function useLogProspectActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProspectActivityBody) => {
      const { data } = await api.post<ApiResponse<ActivityEntry>>(
        "/api/jobs/activity",
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts-by-account"] });
      toast.success("Activity logged");
    },
    onError: () => toast.error("Failed to log activity"),
  });
}
