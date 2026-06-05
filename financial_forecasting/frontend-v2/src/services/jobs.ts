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
    outreach_this_week: number;
    calls_this_week: number;
    outreach_this_month: number;
    total_engagements: number;
    total_calls: number;
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
