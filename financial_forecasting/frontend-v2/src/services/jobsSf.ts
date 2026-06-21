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
