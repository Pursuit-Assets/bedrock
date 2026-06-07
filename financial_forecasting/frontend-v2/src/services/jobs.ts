import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

export type JobStage =
  | "lead_submitted"
  | "initial_outreach"
  | "active_in_discussions"
  | "active_opportunity_confirmed"
  | "active_builder_interview"
  | "closed_won"
  | "closed_lost"
  | "on_hold_not_selected"
  | "on_hold_not_interested"
  | "on_hold_not_responsive";

export type DealType = "ft" | "pt_contract" | "capstone" | "volunteer" | "workshop" | "pilot";

export interface JobsOpportunity {
  id: string;
  account_id: string;
  account_name: string;
  stage: JobStage;
  deal_type: DealType | null;
  title: string | null;
  description: string | null;
  salary_expected: number | null;
  source: string | null;
  owner_email: string | null;
  sf_contact_ids: string[];
  builder_ids: string[];
  sf_opportunity_id: string | null;
  touch_count: number;
  follow_up_date: string | null;
  airtable_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
  activity_count?: number;
}

export interface JobContact {
  contact_id: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
  notes: string | null;
}

export interface ContactsSummary {
  contacts: {
    total: number;
    engaged: number;
    by_stage: { stage: string; count: number }[];
  };
  activity: {
    outreach_total: number;
    outreach_this_week: number;
    calls_total: number;
    calls_this_week: number;
    meetings_total: number;
    outreach_this_month: number;
    active_owners: number;
  };
  active_companies: number;
}

export interface JobsOpportunityDetail extends JobsOpportunity {
  stage_history: StageHistoryEntry[];
  activity: ActivityEntry[];
  contacts: JobContact[];
}

export interface StageHistoryEntry {
  id: string;
  opportunity_id: string;
  from_stage: JobStage | null;
  to_stage: JobStage;
  changed_by: string | null;
  note: string | null;
  changed_at: string;
}

export interface ActivityEntry {
  id: string;
  type: string;
  subject: string | null;
  description: string | null;
  activity_date: string | null;
  source: string;
  logged_by: string | null;
  synced_at: string | null;
  email_from: string | null;
  email_snippet: string | null;
  meeting_duration_minutes: number | null;
  is_jobs: boolean;
  deleted_at: string | null;
}

export interface PipelineStageSummary {
  stage: JobStage;
  label: string;
  group: string;
  total: number;
  by_type: Partial<Record<DealType, number>>;
  avg_salary: number | null;
}

export interface OpportunityFilters {
  stage?: JobStage;
  stage_group?: "lead" | "initial" | "active" | "closed" | "on_hold";
  owner_email?: string;
  account_id?: string;
  deal_type?: DealType;
  limit?: number;
  offset?: number;
}

// ── Labels & metadata ────────────────────────────────────────────────────────

export const STAGE_LABELS: Record<JobStage, string> = {
  lead_submitted:               "Lead Submitted",
  initial_outreach:             "Initial Outreach",
  active_in_discussions:        "In Discussions",
  active_opportunity_confirmed: "Opportunity Confirmed",
  active_builder_interview:     "Builder Interview",
  closed_won:                   "Closed — Won",
  closed_lost:                  "Closed — Lost",
  on_hold_not_selected:         "Not Selected",
  on_hold_not_interested:       "Not Interested",
  on_hold_not_responsive:       "Not Responsive",
};

export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  ft:          "Full-Time",
  pt_contract: "PT / Contract",
  capstone:    "Capstone",
  volunteer:   "Volunteer",
  workshop:    "Workshop",
  pilot:       "Pilot",
};

export const STAGES_ORDERED: JobStage[] = [
  "lead_submitted",
  "initial_outreach",
  "active_in_discussions",
  "active_opportunity_confirmed",
  "active_builder_interview",
  "closed_won",
  "closed_lost",
  "on_hold_not_selected",
  "on_hold_not_interested",
  "on_hold_not_responsive",
];

export const ACTIVE_STAGES: JobStage[] = [
  "active_in_discussions",
  "active_opportunity_confirmed",
  "active_builder_interview",
];

// ── Hooks ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> { success: boolean; data: T }
interface ListResponse<T> { success: boolean; data: T[]; total: number }

export interface JobContactWithDeal extends JobContact {
  airtable_id: string | null;
  deal: { id: string; account_name: string; stage: JobStage; owner_email?: string | null } | null;
}

export interface ContactFilters {
  stage?: string;
  search?: string;
  company?: string;
  limit?: number;
}

export interface ContactDetail extends JobContactWithDeal {
  activity: ActivityEntry[];
}

export function useContactDetail(id: number | null) {
  return useQuery<ContactDetail>({
    queryKey: ["jobs", "contact", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactDetail>>(`/api/jobs/contacts/${id}`);
      return data.data;
    },
    enabled: id !== null,
    staleTime: 30_000,
  });
}

export interface ContactSearchResult {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  source: string | null;
  airtable_id: string | null;
  contact_stage: string | null;
  in_sf: boolean;
  contact_ref: string;  // the ref to store in sf_contact_ids: airtable:XX, pub:123, or sf_id
}

export function useContactSearch(q: string) {
  return useQuery<ContactSearchResult[]>({
    queryKey: ["jobs", "contact-search", q],
    queryFn: async () => {
      if (q.length < 2) return [];
      const { data } = await api.get<ApiResponse<ContactSearchResult[]>>(
        `/api/jobs/contacts/search?q=${encodeURIComponent(q)}&limit=20`
      );
      return data.data;
    },
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

export function useJobsContacts(filters: ContactFilters = {}) {
  const params = new URLSearchParams();
  if (filters.stage)   params.set("stage",   filters.stage);
  if (filters.search)  params.set("search",  filters.search);
  if (filters.company) params.set("company", filters.company);
  params.set("limit", String(filters.limit ?? 200));

  return useQuery<{ data: JobContactWithDeal[]; total: number }>({
    queryKey: ["jobs", "contacts", filters],
    queryFn: async () => {
      const { data } = await api.get<{ success: boolean; data: JobContactWithDeal[]; total: number }>(
        `/api/jobs/contacts?${params}`
      );
      return { data: data.data, total: data.total };
    },
    staleTime: 60_000,
  });
}

export interface MetricDrill {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | null>[];
  count: number;
  entity: "deal" | "contact" | "activity" | "company";
}

export type RoleSegment =
  | "hired_ft" | "hired_contract" | "interviewing"
  | "applied" | "rejected" | "withdrawn" | "other";

export interface JobRole {
  id: string;
  builder: string;
  role_title: string;
  company_name: string;
  salary: number | null;
  stage: string;
  segment: RoleSegment;
}

export interface RolesSummary {
  committed: number;
  hired_ft: number;
  hired_contract: number;
  hired_total: number;
  avg_salary_ft: number | null;
  rows: JobRole[];
}

export interface Placement {
  id: string;
  builder: string;
  role_title: string;
  company_name: string;
  employment_type: string;
  engagement_stage: string | null;
  influenced: boolean | null;
  salary: number | null;
}

export interface PlacementsSummary {
  total: number;
  influenced: number;
  self_sourced: number;
  unclassified: number;
  ft: number;
  contract: number;
  rows: Placement[];
}

export function usePlacements() {
  return useQuery<PlacementsSummary>({
    queryKey: ["jobs", "placements"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<PlacementsSummary>>("/api/jobs/placements");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useUpdatePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, influenced }: { id: string; influenced: boolean | null }) => {
      await api.patch(`/api/jobs/placements/${id}`, { influenced });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "placements"] });
      toast.success("Attribution updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export type FunnelType = "opportunities" | "prospects" | "builders";

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pct_of_max: number;
  conversion_to_next: number | null;
  records: { name: string | null; detail: string | null }[];
}

export interface FunnelProgression {
  name: string;
  from_label: string;
  to_label: string;
  direction: "advanced" | "regressed";
  when: string | null;
}

export interface FunnelData {
  type: FunnelType;
  stages: FunnelStage[];
  progression: FunnelProgression[];
}

export function useJobsFunnel(ftype: FunnelType) {
  return useQuery<FunnelData>({
    queryKey: ["jobs", "funnel", ftype],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<FunnelData>>(`/api/jobs/funnel/${ftype}`);
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useJobRoles() {
  return useQuery<RolesSummary>({
    queryKey: ["jobs", "roles"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<RolesSummary>>("/api/jobs/roles");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useMetricDrill(metricKey: string | null) {
  return useQuery<MetricDrill>({
    queryKey: ["jobs", "metric", metricKey],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<MetricDrill>>(`/api/jobs/metrics/${metricKey}`);
      return data.data;
    },
    enabled: metricKey !== null,
    staleTime: 30_000,
  });
}

export function useContactsSummary() {
  return useQuery<ContactsSummary>({
    queryKey: ["jobs", "contacts-summary"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactsSummary>>("/api/jobs/contacts/summary");
      return data.data;
    },
    staleTime: 60_000,
  });
}

export function useJobsPipeline() {
  return useQuery<PipelineStageSummary[]>({
    queryKey: ["jobs", "pipeline"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<PipelineStageSummary[]>>("/api/jobs/opportunities/pipeline");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useJobsOpportunities(filters: OpportunityFilters = {}) {
  const params = new URLSearchParams();
  if (filters.stage)       params.set("stage",       filters.stage);
  if (filters.stage_group) params.set("stage_group",  filters.stage_group);
  if (filters.owner_email) params.set("owner_email",  filters.owner_email);
  if (filters.account_id)  params.set("account_id",   filters.account_id);
  if (filters.deal_type)   params.set("deal_type",    filters.deal_type);
  params.set("limit",  String(filters.limit  ?? 200));
  params.set("offset", String(filters.offset ?? 0));

  return useQuery<{ data: JobsOpportunity[]; total: number }>({
    queryKey: ["jobs", "opportunities", filters],
    queryFn: async () => {
      const { data } = await api.get<ListResponse<JobsOpportunity>>(`/api/jobs/opportunities?${params}`);
      return { data: data.data, total: data.total };
    },
    staleTime: 30_000,
  });
}

export function useJobsOpportunity(id: string | null) {
  return useQuery<JobsOpportunityDetail>({
    queryKey: ["jobs", "opportunity", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsOpportunityDetail>>(`/api/jobs/opportunities/${id}`);
      return data.data;
    },
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useUpdateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<JobsOpportunity>>(`/api/jobs/opportunities/${id}`, body);
      return data.data;
    },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(`Updated → ${STAGE_LABELS[updated.stage]}`);
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<JobsOpportunity>) => {
      const { data } = await api.post<ApiResponse<JobsOpportunity>>("/api/jobs/opportunities", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Deal created");
    },
    onError: () => toast.error("Failed to create deal"),
  });
}

export interface ContactCreateBody {
  full_name: string;
  email?: string;
  current_title?: string;
  current_company?: string;
  contact_stage?: string;
  linkedin_url?: string;
  notes?: string;
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ContactCreateBody) => {
      const { data } = await api.post<ApiResponse<JobContact>>("/api/jobs/contacts", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Contact created");
    },
    onError: () => toast.error("Failed to create contact"),
  });
}

export function useDeleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (activityId: string) => {
      await api.delete(`/api/jobs/activity/${activityId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Activity deleted");
    },
    onError: () => toast.error("Delete failed"),
  });
}

export interface Builder { user_id: number; email: string; name: string; cohort: string }

export function useAddContactToJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, add }: { id: number; add: boolean }) => {
      if (add) {
        await api.post(`/api/jobs/contacts/${id}/add-to-jobs`);
      } else {
        await api.delete(`/api/jobs/contacts/${id}/add-to-jobs`);
      }
    },
    onSuccess: (_, { add }) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success(add ? "Added to Jobs pipeline" : "Removed from Jobs pipeline");
    },
    onError: () => toast.error("Failed to update contact"),
  });
}

export function useBuilders(search?: string) {
  return useQuery<Builder[]>({
    queryKey: ["jobs", "builders", search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : "";
      const { data } = await api.get<ApiResponse<Builder[]>>(`/api/jobs/builders${params}`);
      return data.data;
    },
    staleTime: 300_000,
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<JobContact>>(`/api/jobs/contacts/${id}`, body);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.id] });
      toast.success("Contact updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export interface ActivityCreateBody {
  jobs_opportunity_id: string;
  type: "email" | "call" | "meeting" | "note";
  description: string;
  activity_date?: string;
  subject?: string;
}

export function useLogActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ActivityCreateBody) => {
      const { data } = await api.post<ApiResponse<ActivityEntry>>("/api/jobs/activity", body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Activity logged");
    },
    onError: () => toast.error("Failed to log activity"),
  });
}

export function useDeleteOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/jobs/opportunities/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Deal removed");
    },
  });
}
