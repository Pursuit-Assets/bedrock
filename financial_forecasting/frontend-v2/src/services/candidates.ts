import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Candidate funnel — companies + people Pursuit has seen in Gmail/Calendar
 * activity but not yet tracked in Salesforce or public.contacts. Each
 * candidate has 4 outcome buttons (track / promote-sf / tag-existing / reject).
 *
 * Backend: routes/candidates.py.
 * Schema:  db/migrations/2026-06-07-add-candidate-funnel.sql.
 */

export interface AccountCandidate {
  id: string;
  primary_domain: string;
  display_name: string | null;
  alt_domains: string[];
  first_seen_at: string;
  last_seen_at: string;
  first_source: string;
  signal_count: number;
  unique_people: number;
  public_company_id: number | null;
  sf_account_id: string | null;
  status: CandidateStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
}

export interface ContactCandidate {
  id: string;
  email: string;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  first_source: string;
  signal_count: number;
  account_candidate_id: string | null;
  account_candidate_domain: string | null;
  sf_account_id: string | null;
  sf_account_name: string | null;
  sf_contact_id: string | null;
  public_contact_id: number | null;
  status: CandidateStatus;
  title: string | null;
  linkedin_url: string | null;
}

export type CandidateStatus =
  | "new"
  | "tracking"
  | "in_registry"
  | "promoted"
  | "merged"
  | "rejected";

export interface CandidateListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AccountCandidateFilters {
  status?: CandidateStatus[];
  minSignal?: number;
  hasSfAccount?: boolean;
  search?: string;
  sort?: "signal_count_desc" | "last_seen_desc" | "first_seen_asc";
  limit?: number;
  offset?: number;
}

export interface ContactCandidateFilters extends AccountCandidateFilters {
  domain?: string;
}

function toParams(f: AccountCandidateFilters | ContactCandidateFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status && f.status.length) p.set("status", f.status.join(","));
  if (f.minSignal && f.minSignal > 0) p.set("min_signal", String(f.minSignal));
  if (typeof f.hasSfAccount === "boolean") p.set("has_sf_account", String(f.hasSfAccount));
  if (f.search) p.set("search", f.search);
  if (f.sort) p.set("sort", f.sort);
  if (f.limit) p.set("limit", String(f.limit));
  if (f.offset) p.set("offset", String(f.offset));
  if ("domain" in f && f.domain) p.set("domain", f.domain);
  return p;
}

export function useAccountCandidates(filters: AccountCandidateFilters) {
  return useQuery({
    queryKey: ["candidates", "accounts", filters],
    queryFn: async () => {
      const { data } = await api.get<CandidateListResponse<AccountCandidate>>(
        `/api/candidates/accounts?${toParams(filters).toString()}`,
      );
      return data;
    },
    staleTime: 30_000,
  });
}

// ── Detail (smart suggestions) ────────────────────────────────────────

export interface InternalCounterpart {
  email: string;
  display_name: string;
  interaction_count: number;
}

export interface RecentActivity {
  activity_date: string | null;
  source: string;
  type: string;
  subject: string | null;
  email_from: string | null;
  snippet: string | null;
}

export interface PublicContactMatch {
  contact_id: number;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  linkedin_url: string | null;
  current_title: string | null;
  current_company: string | null;
  sf_contact_id: string | null;
  sf_account_id: string | null;
}

export interface SfAccountSuggestion {
  sf_account_id: string;
  sf_account_name: string | null;
}

export interface ContactCandidateDetail {
  id: string;
  email: string;
  display_name: string | null;
  status: CandidateStatus;
  signal_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  sf_account_id: string | null;
  sf_account_name: string | null;
  sf_contact_id: string | null;
  account_candidate_id: string | null;
  account_candidate_domain: string | null;
  account_candidate_display: string | null;
  internal_counterparts: InternalCounterpart[];
  recent_activity: RecentActivity[];
  total_activity_count: number;
  public_contact_exact_match: PublicContactMatch | null;
  public_contacts_same_domain: PublicContactMatch[];
  sf_account_suggestion: SfAccountSuggestion | null;
}

export interface PublicCompanyMatch {
  company_id: number;
  name: string | null;
  domain: string | null;
  logo_url: string | null;
  industry: string | null;
  size_bucket: string | null;
  hq_location: string | null;
}

export interface AccountCandidateDetail {
  id: string;
  primary_domain: string;
  display_name: string | null;
  status: CandidateStatus;
  signal_count: number;
  unique_people: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  sf_account_id: string | null;
  public_company_id: number | null;
  sf_account_suggestion: SfAccountSuggestion | null;
  public_company: PublicCompanyMatch | null;
  top_people: Array<{
    id: string;
    email: string;
    display_name: string | null;
    signal_count: number;
    last_seen_at: string | null;
    status: CandidateStatus;
    sf_contact_id: string | null;
    public_contact_id: number | null;
  }>;
  internal_counterparts: InternalCounterpart[];
}

export function useContactCandidateDetail(id: string | null) {
  return useQuery({
    queryKey: ["candidates", "contacts", "detail", id],
    queryFn: async () => {
      const { data } = await api.get<ContactCandidateDetail>(
        `/api/candidates/contacts/${id}/detail`,
      );
      return data;
    },
    staleTime: 30_000,
    enabled: !!id,
  });
}

export function useAccountCandidateDetail(id: string | null) {
  return useQuery({
    queryKey: ["candidates", "accounts", "detail", id],
    queryFn: async () => {
      const { data } = await api.get<AccountCandidateDetail>(
        `/api/candidates/accounts/${id}/detail`,
      );
      return data;
    },
    staleTime: 30_000,
    enabled: !!id,
  });
}

export function useContactCandidates(filters: ContactCandidateFilters) {
  return useQuery({
    queryKey: ["candidates", "contacts", filters],
    queryFn: async () => {
      const { data } = await api.get<CandidateListResponse<ContactCandidate>>(
        `/api/candidates/contacts?${toParams(filters).toString()}`,
      );
      return data;
    },
    staleTime: 30_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────

type AccountAction = "track" | "reject";
type ContactAction = "track" | "reject";

function useCandidateMutation<TVars>(
  endpoint: (vars: TVars) => string,
  body?: (vars: TVars) => unknown,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const { data } = await api.post(endpoint(vars), body ? body(vars) : {});
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["candidates"] });
    },
  });
}

export function useAccountCandidateSimple(action: AccountAction) {
  return useCandidateMutation<{ id: string; notes?: string }>(
    (v) => `/api/candidates/accounts/${v.id}/${action}`,
    (v) => (v.notes !== undefined ? { notes: v.notes } : {}),
  );
}

export function usePromoteAccountToSf() {
  return useCandidateMutation<{
    id: string;
    sf_account_name: string;
    sf_account_type?: string;
  }>(
    (v) => `/api/candidates/accounts/${v.id}/promote-sf`,
    ({ sf_account_name, sf_account_type }) => ({ sf_account_name, sf_account_type }),
  );
}

export function useTagAccountToExisting() {
  return useCandidateMutation<{
    id: string;
    sf_account_id: string;
    sf_account_name?: string;
  }>(
    (v) => `/api/candidates/accounts/${v.id}/tag-existing`,
    ({ sf_account_id, sf_account_name }) => ({ sf_account_id, sf_account_name }),
  );
}

export function useContactCandidateSimple(action: ContactAction) {
  return useCandidateMutation<{ id: string; notes?: string }>(
    (v) => `/api/candidates/contacts/${v.id}/${action}`,
    (v) => (v.notes !== undefined ? { notes: v.notes } : {}),
  );
}

export function usePromoteContactToSf() {
  return useCandidateMutation<{
    id: string;
    first_name: string;
    last_name: string;
    sf_account_id?: string;
    title?: string;
  }>(
    (v) => `/api/candidates/contacts/${v.id}/promote-sf`,
    ({ first_name, last_name, sf_account_id, title }) => ({
      first_name, last_name, sf_account_id, title,
    }),
  );
}

export function useTagContactToExisting() {
  return useCandidateMutation<{
    id: string;
    sf_contact_id: string;
    sf_account_id?: string;
  }>(
    (v) => `/api/candidates/contacts/${v.id}/tag-existing`,
    ({ sf_contact_id, sf_account_id }) => ({ sf_contact_id, sf_account_id }),
  );
}
