/**
 * Salesforce bridge for jobs entities. Backed by /api/jobs/sf/*.
 *
 * Promoting a contact makes it ONE shared record with Salesforce: we dedup
 * first (link an existing SF contact rather than duplicate), resolve the
 * contact's account (link/create), then create + link-back.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface ApiResponse<T> { success: boolean; data: T }

export interface SfContactRef {
  id: string;
  name: string | null;
  email: string | null;
  title?: string | null;
  account_id: string | null;
  account_name: string | null;
}

export interface ContactSfStatus {
  linked: boolean;
  sf_contact_id: string | null;
  sf_account_id: string | null;
  sf_contact: SfContactRef | null;
  proposed: {
    FirstName: string | null;
    LastName: string | null;
    Email: string | null;
    Title: string | null;
    LinkedIn_URL__c: string | null;
  };
  company: string | null;
}

export interface SfAccountRef {
  id: string;
  name: string | null;
  city?: string | null;
  type?: string | null;
}

export function useContactSfStatus(contactId: number | null) {
  return useQuery<ContactSfStatus>({
    queryKey: ["jobs", "sf", "contact", contactId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactSfStatus>>(`/api/jobs/sf/contact/${contactId}`);
      return data.data;
    },
    enabled: contactId != null,
    staleTime: 30_000,
  });
}

export function useSearchSfContacts() {
  return useMutation({
    mutationFn: async (q: { email?: string; name?: string; company?: string }) => {
      const params = new URLSearchParams();
      if (q.email) params.set("email", q.email);
      if (q.name) params.set("name", q.name);
      if (q.company) params.set("company", q.company);
      const { data } = await api.get<ApiResponse<{ candidates: SfContactRef[]; exact_email_match: boolean }>>(
        `/api/jobs/sf/search-contacts?${params.toString()}`,
      );
      return data.data;
    },
  });
}

export function useSearchSfAccounts() {
  return useMutation({
    mutationFn: async (name: string) => {
      const { data } = await api.get<ApiResponse<{ candidates: SfAccountRef[] }>>(
        `/api/jobs/sf/search-accounts?name=${encodeURIComponent(name)}`,
      );
      return data.data.candidates;
    },
  });
}

/** A jobs account is "in Salesforce" when it carries a real SF account id
 *  (15/18-char, starts with 001) — either derived from its opps or pinned by
 *  an explicit promote. */
export function isSfAccountId(id: string | null | undefined): boolean {
  return !!id && (id.length === 15 || id.length === 18) && id.startsWith("001");
}

export interface PromoteAccountBody {
  account_key: string;
  display_name: string;
  mode: "link" | "create";
  sf_account_id?: string;
}

export function usePromoteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PromoteAccountBody) => {
      const { data } = await api.post<ApiResponse<{ sf_account_id: string; linked: boolean }>>(
        "/api/jobs/sf/promote-account",
        body,
      );
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
      toast.success("Account linked to Salesforce");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: { message?: string } | string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : (msg?.message ?? "Promote failed"));
    },
  });
}

export interface HandoffOpportunityBody {
  opp_id: string;
  name: string;
  stage: string;
  amount?: number | null;
  close_date: string;
  primary_contact_sf_id?: string;
  account_sf_id?: string;
  account_create_name?: string;
}

export function useHandoffOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: HandoffOpportunityBody) => {
      const { data } = await api.post<ApiResponse<{ sf_opportunity_id: string; account_id: string }>>(
        "/api/jobs/sf/handoff-opportunity",
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opportunity", vars.opp_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "opportunities"] });
      toast.success("Handed off to PBC");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: { message?: string } | string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : (msg?.message ?? "Handoff failed"));
    },
  });
}

export interface PromoteContactBody {
  contact_id: number;
  mode: "link" | "create";
  sf_contact_id?: string;
  account?: { mode: "link" | "create" | "none"; sf_account_id?: string; name?: string };
  fields?: Record<string, string | null>;
}

export function usePromoteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: PromoteContactBody) => {
      const { data } = await api.post<ApiResponse<{ sf_contact_id: string; sf_account_id: string | null; linked: boolean }>>(
        "/api/jobs/sf/promote-contact",
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "sf", "contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(vars.mode === "link" ? "Linked to Salesforce" : "Added to Salesforce");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: { message?: string } | string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : (msg?.message ?? "Promote failed"));
    },
  });
}
