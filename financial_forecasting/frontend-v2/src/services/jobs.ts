import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Invalidate the query families that depend on opportunities/activity — opp
 * list + detail, account rollups, and pipeline metrics. Replaces blanket
 * invalidation of the whole ["jobs"] tree (which also refetched staff and
 * unrelated metric drawers). `extra` adds caller-specific families.
 */
function invalidateOppDependents(qc: QueryClient, extra: string[][] = []) {
  const families = [
    ["jobs", "opportunities"],
    ["jobs", "opportunity"],
    ["jobs", "accounts"],
    ["jobs", "account-rollup"],
    ["jobs", "pipeline"],
    ["jobs", "funnel"],
    ["jobs", "this-week-summary"],
    ...extra,
  ];
  for (const queryKey of families) qc.invalidateQueries({ queryKey });
}

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
  relationship_owner: string | null;
  sf_contact_ids: string[];
  builder_ids: string[];
  sf_opportunity_id: string | null;
  touch_count: number;
  follow_up_date: string | null;
  airtable_id: string | null;
  num_roles: number | null;
  likelihood: "low" | "medium" | "high" | null;
  closed_lost_reason?: string | null;
  closed_lost_note?: string | null;
  priority?: number | null;
  priority_auto?: number | null;
  priority_suggested?: number | null;
  open_tasks?: number;
  segment?: string | null;
  intro_by?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
  activity_count?: number;
  last_activity_at?: string | null;
  recent_activity_count?: number;
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
}

export interface ContactsSummary {
  contacts: {
    total: number;
    engaged: number;
    by_stage: { stage: string; count: number }[];
  };
  accounts: { total: number; engaged: number };
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
  email_to: string[] | null;
  email_snippet: string | null;
  email_body_text: string | null;
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
  connected_staff_names?: string[];
  recent_activity_count?: number;
  last_activity_at?: string | null;
  responded?: boolean;
  activity_actors?: string[];
  open_tasks?: number;
}

export interface ContactFilters {
  stage?: string;
  search?: string;
  company?: string;
  limit?: number;
}

export interface ConnectedStaff {
  staff_user_id: number;
  name: string | null;
  email: string | null;
  source: string | null;
  strength: string | null;
  connected_date: string | null;
}

export interface ContactDetail extends JobContactWithDeal {
  activity: ActivityEntry[];
  connected_staff?: ConnectedStaff[];
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

// Prospects grouped into account rows (by company name) for the account-level
// Prospects view. Each account carries its current opportunity, if any.
export interface ProspectAccountContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface ProspectAccount {
  account: string;
  contact_count: number;
  contacts: ProspectAccountContact[];
  deal: { id: string; stage: JobStage; deal_type: DealType | null; owner_email: string | null } | null;
}

export function useContactsByAccount(dealType?: string) {
  const params = new URLSearchParams();
  if (dealType && dealType !== "all") params.set("deal_type", dealType);
  return useQuery<ProspectAccount[]>({
    queryKey: ["jobs", "contacts-by-account", dealType ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ProspectAccount[]>>(
        `/api/jobs/contacts/by-account?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// Account-level hub: every company (keyed by normalized name) with its
// opportunities + prospects nested and a derived status (same vocabulary as the
// portfolio Accounts tab). Backed by GET /api/jobs/accounts.
export type JobsAccountStatus = "Prospect" | "Activating" | "Pursuing" | "Stewarding" | "Re-activating" | "Dormant";

export interface JobsAccountOpp {
  id: string;
  title: string | null;
  stage: JobStage;
  deal_type: DealType | null;
  owner_email: string | null;
  priority: number | null;
  num_roles: number | null;
  likelihood: "low" | "medium" | "high" | null;
  updated_at: string | null;
}

export interface JobsAccountProspect {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface JobsAccount {
  account: string;
  account_key: string;
  account_id: string | null;
  sf_account_id?: string | null;
  owner_email: string | null;
  account_status: JobsAccountStatus;
  opportunities: JobsAccountOpp[];
  prospects: JobsAccountProspect[];
  opp_count: number;
  prospect_count: number;
  last_activity: string | null;
  open_tasks?: number;
  recent_activity_count?: number;
  last_activity_at?: string | null;
  responded?: boolean;
  /** Jobs-team members (emails) who have touched this account — for the team filter. */
  activity_actors?: string[];
  /** Builders we placed here (our DB). */
  builders_hired?: number;
  /** Historical Pursuit fellows hired here (from Salesforce); null until enriched. */
  fellows_hired?: number | null;
  /** All SF account ids this account resolves to (for joining SF fellow counts). */
  sf_account_ids?: string[];
}

export function useJobsAccounts(dealType?: string) {
  const params = new URLSearchParams();
  if (dealType && dealType !== "all") params.set("deal_type", dealType);
  return useQuery<JobsAccount[]>({
    queryKey: ["jobs", "accounts", dealType ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsAccount[]>>(`/api/jobs/accounts?${params}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

export interface ContactOpportunity {
  id: string;
  account_name: string;
  title: string | null;
  stage: JobStage;
  deal_type: DealType | null;
  owner_email: string | null;
  num_roles: number | null;
  priority: number | null;
  updated_at: string | null;
}

export function useContactOpportunities(id: number | null) {
  return useQuery<ContactOpportunity[]>({
    queryKey: ["jobs", "contact-opps", id],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ContactOpportunity[]>>(`/api/jobs/contacts/${id}/opportunities`);
      return data.data;
    },
    enabled: id !== null,
    staleTime: 60_000,
  });
}

// ── Account roll-ups (read aggregations across an account's opps + contacts) ──
type AccountScope = "opportunity" | "contact";

export interface AccountTask {
  id: string; title: string | null; status: string | null; deadline: string | null;
  scope: AccountScope; parent_id: string; scope_label: string;
}
export interface AccountComment {
  id: string; author_email: string | null; content: string; created_at: string | null;
  scope: AccountScope; scope_label: string;
}
export interface AccountBuilderRow {
  job_application_id: number; builder: string | null; company_name: string | null;
  role_title: string | null; stage: string | null; jobs_role_id: string | null; date_applied: string | null;
  opportunity_id: string | null; opp_title: string | null;
}
export interface AccountRole {
  id: string; opportunity_id: string; opp_title: string | null; title: string | null;
  status: string | null; employment_type: string | null; approx_salary: number | null;
  commitment: string | null; is_trial: boolean | null; filled_by_user_id: number | null;
}

function accountRollup<T>(kind: string, key: string | null) {
  return useQuery<T>({
    queryKey: ["jobs", "account-rollup", kind, key],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<T>>(`/api/jobs/account-${kind}?key=${encodeURIComponent(key ?? "")}`);
      return data.data;
    },
    enabled: Boolean(key),
    staleTime: 30_000,
  });
}

export const useAccountActivity = (key: string | null) => accountRollup<ActivityEntry[]>("activity", key);
export const useAccountTasks    = (key: string | null) => accountRollup<AccountTask[]>("tasks", key);
export const useAccountComments = (key: string | null) => accountRollup<AccountComment[]>("comments", key);
export const useAccountBuilders = (key: string | null) => accountRollup<{ rows: AccountBuilderRow[]; summary: Record<string, number> }>("builders", key);
export const useAccountRoles    = (key: string | null) => accountRollup<AccountRole[]>("roles", key);

export interface JobsStaff { email: string; name: string }

export function useJobsStaff() {
  return useQuery<JobsStaff[]>({
    queryKey: ["jobs", "staff"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<JobsStaff[]>>("/api/jobs/staff");
      return data.data;
    },
    staleTime: 300_000,
  });
}

export interface JobsAccountUpdate {
  account: string;
  owner_email?: string;
  status_override?: string;
  notes?: string;
}

export function useUpdateJobsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: JobsAccountUpdate) => {
      await api.patch("/api/jobs/accounts", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "accounts"] });
    },
    onError: () => toast.error("Couldn't save account change"),
  });
}

export interface MetricDrill {
  title: string;
  columns: { key: string; label: string }[];
  rows: (Record<string, string | null> & { _children?: Record<string, string | null>[] })[];
  count: number;
  entity: "deal" | "contact" | "activity" | "company" | "placement" | "salary";
  child_columns: { key: string; label: string }[] | null;
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
  ft_builders: number;
  any_builders: number;
  influenced_ft: number;
  influenced_any: number;
  committed_ft_roles: number;
  ft_roles_secured: number;
  avg_salary_ft_placed: number | null;
  avg_salary_ft_secured: number | null;
  interviewing: number;
  rows: Placement[];
}

export interface BuilderSegment { value: string; label: string; count: number }
export function useBuilderSegments() {
  return useQuery<{ segments: BuilderSegment[]; total: number }>({
    queryKey: ["jobs", "builder-segments"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<{ segments: BuilderSegment[]; total: number }>>("/api/jobs/builder-segments");
      return data.data;
    },
    staleTime: 5 * 60_000,
  });
}

export interface WeekSummaryPerson {
  email: string;
  name: string | null;
  company: string | null;
  when: string | null;
}
export interface WeekSummaryProgress {
  account: string | null;
  from_stage: string;
  to_stage: string;
  when: string | null;
}
export interface ThisWeekSummary {
  emailed: WeekSummaryPerson[];
  met: WeekSummaryPerson[];
  progressed: WeekSummaryProgress[];
  counts: { emailed: number; met: number; progressed: number };
}

export function useThisWeekSummary() {
  return useQuery<ThisWeekSummary>({
    queryKey: ["jobs", "this-week-summary"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ThisWeekSummary>>("/api/jobs/this-week-summary");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function usePlacements(segment?: string) {
  const seg = segment && segment !== "all" ? segment : undefined;
  return useQuery<PlacementsSummary>({
    queryKey: ["jobs", "placements", seg ?? "all"],
    queryFn: async () => {
      const qs = seg ? `?segment=${encodeURIComponent(seg)}` : "";
      const { data } = await api.get<ApiResponse<PlacementsSummary>>(`/api/jobs/placements${qs}`);
      return data.data;
    },
    staleTime: 30_000,
  });
}

export interface OppPlacement {
  id: string;
  builder: string;
  role_title: string | null;
  company_name: string | null;
  employment_type: string;
  salary?: number | null;
}

export function useOppPlacements(oppId: string | null) {
  return useQuery<OppPlacement[]>({
    queryKey: ["jobs", "opp-placements", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OppPlacement[]>>(`/api/jobs/opportunities/${oppId}/placements`);
      return data.data;
    },
    enabled: oppId !== null,
    staleTime: 15_000,
  });
}

export function useUnlinkedPlacements(q: string) {
  return useQuery<OppPlacement[]>({
    queryKey: ["jobs", "unlinked-placements", q],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<OppPlacement[]>>(
        `/api/jobs/placements/unlinked${q ? `?q=${encodeURIComponent(q)}` : ""}`
      );
      return data.data;
    },
    staleTime: 15_000,
  });
}

export function useCreatePlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, ...body }: {
      oppId: string; builder_user_id?: number; builder_name?: string;
      role_title?: string; employment_type?: string; salary?: number;
    }) => {
      const { data } = await api.post<ApiResponse<{ id: string }>>(
        `/api/jobs/opportunities/${oppId}/placements`, body
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-placements", vars.oppId] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"]]);
      toast.success("Placement recorded");
    },
    onError: () => toast.error("Failed to record placement"),
  });
}

export function useLinkPlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, placementId }: { oppId: string; placementId: string }) => {
      await api.post(`/api/jobs/opportunities/${oppId}/placements/${placementId}/link`);
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-placements", vars.oppId] });
      invalidateOppDependents(qc, [["jobs", "placements"], ["jobs", "builders"], ["jobs", "unlinked-placements"]]);
      toast.success("Placement linked");
    },
    onError: () => toast.error("Failed to link placement"),
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

export function useUpdatePlacementSalary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, salary }: { id: string; salary: number }) => {
      await api.patch(`/api/jobs/placements/${id}`, { salary });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "placements"] });
      qc.invalidateQueries({ queryKey: ["jobs", "metric"] });
      toast.success("Salary updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export type FunnelType = "opportunities" | "prospects" | "builders";

export interface FunnelMovement {
  name: string;
  from_label: string;
  to_label: string;
  direction: "advanced" | "regressed";
  flow: "in" | "out";
  when: string | null;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pct_of_max: number;
  conversion_to_next: number | null;
  records: Record<string, string | null>[];
  movement: FunnelMovement[];
  advanced_in: number;
  regressed_in: number;
}

export interface FunnelData {
  type: FunnelType;
  stages: FunnelStage[];
  record_columns: { key: string; label: string }[];
}

export function useJobsFunnel(ftype: FunnelType, dealType?: string, segment?: string) {
  const dt = dealType && dealType !== "all" ? dealType : undefined;
  const seg = segment && segment !== "all" ? segment : undefined;
  return useQuery<FunnelData>({
    queryKey: ["jobs", "funnel", ftype, dt ?? "all", seg ?? "all"],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (dt) p.set("deal_type", dt);
      if (seg) p.set("segment", seg);
      const qs = p.toString() ? `?${p}` : "";
      const { data } = await api.get<ApiResponse<FunnelData>>(`/api/jobs/funnel/${ftype}${qs}`);
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

export interface ActivityTrendBucket {
  period: string;
  new: number;
  existing: number;
}
export type OutreachChannel = "all" | "email" | "meeting";
export interface ActivityTrends {
  granularity: "week" | "month";
  channel: OutreachChannel;
  buckets: ActivityTrendBucket[];
  totals: { new: number; existing: number; touches: number };
  coverage_note: string | null;
}

export function useActivityTrends(granularity: "week" | "month", channel: OutreachChannel) {
  return useQuery<ActivityTrends>({
    queryKey: ["jobs", "activity-trends", granularity, channel],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<ActivityTrends>>(
        `/api/jobs/activity-trends?granularity=${granularity}&channel=${channel}`,
      );
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
      return { updated: data.data, changedStage: "stage" in body };
    },
    onSuccess: ({ updated, changedStage }) => {
      // a stage/contact change ripples into placements + contacts too
      invalidateOppDependents(qc, [
        ["jobs", "placements"], ["jobs", "contacts"],
        ["jobs", "contacts-by-account"], ["jobs", "contacts-summary"],
      ]);
      // Only announce the stage when the stage was the field that changed —
      // otherwise (owner, salary, # roles, …) a plain "Updated" is honest.
      toast.success(
        changedStage ? `Stage → ${STAGE_LABELS[updated.stage] ?? updated.stage}` : "Updated",
      );
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
      // new opp can flip linked contacts to is_jobs_contact → refresh contacts
      invalidateOppDependents(qc, [
        ["jobs", "contacts"], ["jobs", "contacts-by-account"], ["jobs", "contacts-summary"],
      ]);
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
      invalidateOppDependents(qc, [["jobs", "contact"], ["jobs", "metric"]]);
      toast.success("Activity deleted");
    },
    onError: () => toast.error("Delete failed"),
  });
}

export interface Staff { email: string; name: string }

export function useStaff(q?: string) {
  return useQuery<Staff[]>({
    queryKey: ["jobs", "staff", q ?? ""],
    queryFn: async () => {
      const params = q ? `?q=${encodeURIComponent(q)}` : "";
      const { data } = await api.get<ApiResponse<Staff[]>>(`/api/jobs/staff${params}`);
      return data.data;
    },
    staleTime: 300_000,
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

// ── Email-review candidates (Home page queue) ─────────────────────────────────
export interface JobCandidate {
  contact_id: number;
  full_name: string | null;
  email: string;
  current_company: string | null;
  current_title: string | null;
  domain?: string | null;
  suggested_account?: string | null;
  email_count: number;
  last_email: string | null;
  last_subject: string | null;
}

export interface AccountSuggestion {
  account_key: string | null;
  account_name: string | null;
  sf_account_id: string | null;
  confidence: "high" | "medium" | "low";
  in_pipeline: boolean;
  reason: string;
}
export interface CandidateEmail {
  id: string;
  subject: string | null;
  email_from: string | null;
  email_to: string[] | null;
  snippet: string | null;
  body: string | null;
  type: string | null;
  source: string | null;
  activity_date: string | null;
}
export interface CandidateDetail {
  contact: { contact_id: number; full_name: string | null; email: string; current_company: string | null; current_title: string | null; linkedin_url: string | null };
  suggested_account: AccountSuggestion | null;
  emails: CandidateEmail[];
}
export interface CandidateEnrichment {
  full_name?: string | null;
  title?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  is_employer_contact?: boolean;
  confidence?: "high" | "medium" | "low";
  reasoning?: string;
  error?: string;
}

export function useCandidates() {
  return useQuery({
    queryKey: ["jobs", "candidates"],
    queryFn: async (): Promise<JobCandidate[]> => {
      const { data } = await api.get<ApiResponse<JobCandidate[]>>("/api/jobs/candidates");
      return data.data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useCandidateDetail(contactId: number | null) {
  return useQuery({
    queryKey: ["jobs", "candidate", contactId],
    queryFn: async (): Promise<CandidateDetail> => {
      const { data } = await api.get<ApiResponse<CandidateDetail>>(`/api/jobs/candidates/${contactId}`);
      return data.data;
    },
    enabled: contactId != null,
  });
}

/** AI-extract name/title/company from the candidate's emails (Claude). */
export function useEnrichCandidate() {
  return useMutation({
    mutationFn: async (contactId: number): Promise<CandidateEnrichment> => {
      const { data } = await api.post<ApiResponse<CandidateEnrichment>>(`/api/jobs/candidates/${contactId}/enrich`, {});
      return data.data;
    },
  });
}

export function usePromoteCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: number; full_name?: string; current_company?: string; current_title?: string; contact_stage?: string }) => {
      const { data } = await api.post<ApiResponse<unknown>>(`/api/jobs/candidates/${id}/promote`, body);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts"] });
      toast.success("Added to pipeline");
    },
    onError: () => toast.error("Promote failed"),
  });
}

export function useDismissCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => { await api.post(`/api/jobs/candidates/${id}/dismiss`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs", "candidates"] });
      toast.success("Dismissed");
    },
    onError: () => toast.error("Dismiss failed"),
  });
}

export interface ActivityCreateBody {
  jobs_opportunity_id: string;
  type: "call" | "text" | "linkedin";
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
      invalidateOppDependents(qc, [["jobs", "contact"], ["jobs", "metric"]]);
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
      invalidateOppDependents(qc, [["jobs", "placements"]]);
      toast.success("Deal removed");
    },
  });
}

// ── Builders tab ──────────────────────────────────────────────────────────────

export type BuilderStatus =
  | "not_started" | "actively_applying" | "interviewing" | "placed" | "paused";

export const BUILDER_STATUS_ORDER: BuilderStatus[] = [
  "actively_applying", "interviewing", "placed", "paused", "not_started",
];

export const BUILDER_STATUS_LABELS: Record<BuilderStatus, string> = {
  not_started: "Not Started",
  actively_applying: "Actively Applying",
  interviewing: "Interviewing",
  placed: "Placed",
  paused: "Paused",
};

export const BUILDER_STATUS_STYLES: Record<BuilderStatus, string> = {
  not_started:       "text-ink-3 bg-surface-2",
  actively_applying: "text-[var(--accent)] bg-[var(--accent-soft)]",
  interviewing:      "text-[var(--amber)] bg-[var(--amber-soft)]",
  placed:            "text-[var(--green)] bg-[var(--green-soft)]",
  paused:            "text-ink-3 bg-surface-2",
};

export interface BuilderBoardRow {
  user_id: number;
  name: string | null;
  email: string | null;
  cohort: string | null;
  cohort_completed: boolean;
  status: BuilderStatus;
  status_overridden: boolean;
  coach: string | null;
  counts: { applications: number; interviews: number; placements: number; deal_matches: number };
  readiness: { complete: number; total: number; lookbook: boolean; linkedin: boolean; github: boolean; cv: boolean; mock: boolean };
  prof_strength: string | null;
  technical_strength: string | null;
  has_profile: boolean;
}

export interface BuilderBoard {
  builders: BuilderBoardRow[];
  status_counts: Record<BuilderStatus, number>;
}

export interface BuilderApplication {
  id: number; company_name: string | null; role_title: string | null; stage: string | null;
  date_applied: string | null; salary: string | null; job_url: string | null; response_date: string | null;
}
export interface BuilderPlacement {
  id: number; role_title: string | null; company_name: string | null; employment_type: string | null;
  payment_amount: number | null; engagement_stage: string | null; influenced: boolean | null;
  opportunity_id: string | null; start_date: string | null;
}
export interface BuilderDealMatch {
  id: string; account_name: string | null; stage: JobStage; deal_type: DealType | null; owner_email: string | null;
}
export interface BuilderJobProfile {
  job_search_status: string | null; status_overridden: boolean;
  pursuit_coach: string | null; gen_notes: string | null; coach_notes: string | null;
  coach_flags: string[]; improvement_tags: string[];
  ready_lookbook: boolean; ready_linkedin: boolean; ready_github: boolean; ready_cv: boolean; ready_mock: boolean;
  technical_capability: string | null; ai_reasoning: string | null; problem_solving: string | null;
  presentation: string | null; professional_behaviors: string | null;
  prof_strength: string | null; technical_strength: string | null;
  target_industries: string[]; preferred_modes: string[]; certifications: string[];
  resume_url: string | null; lookbook_url: string | null;
  university: string | null; degree: string | null; graduation_year: number | null; languages: string[];
  applying_regularly: boolean | null; networking_regularly: boolean | null;
  intake: Record<string, unknown> | null;
}
export interface BuilderDetail {
  identity: {
    user_id: number; name: string | null; email: string | null; cohort: string | null;
    cohort_completed: boolean; linkedin_url: string | null; github_url: string | null;
  };
  status: BuilderStatus; status_overridden: boolean; derived_status: BuilderStatus;
  applications: BuilderApplication[];
  placements: BuilderPlacement[];
  deal_matches: BuilderDealMatch[];
  intake_quiz: { question_key: string; response_text: string | null; response_structured: unknown }[];
  enrollment: { current_profile: string | null; onboarding_completed_at: string | null; has_coach: boolean | null } | null;
  learning: { skill_levels: Record<string, number> | null; competencies: unknown; interview_readiness: number | null } | null;
  profile: BuilderJobProfile | null;
}

export function useBuilderBoard() {
  return useQuery<BuilderBoard>({
    queryKey: ["jobs", "builders"],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderBoard>>("/api/jobs/builders/board");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useBuilderDetail(userId: number | null) {
  return useQuery<BuilderDetail>({
    queryKey: ["jobs", "builder", userId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderDetail>>(`/api/jobs/builders/${userId}`);
      return data.data;
    },
    enabled: userId !== null,
    staleTime: 30_000,
  });
}

export function useUpdateBuilderProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, ...body }: { userId: number; [k: string]: unknown }) => {
      const { data } = await api.patch<ApiResponse<BuilderJobProfile>>(`/api/jobs/builders/${userId}`, body);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "builders"] });
      qc.invalidateQueries({ queryKey: ["jobs", "builder", vars.userId] });
    },
    onError: () => toast.error("Update failed"),
  });
}
