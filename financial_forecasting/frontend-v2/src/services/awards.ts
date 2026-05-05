import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type AwardStatus = "Active" | "Closing" | "Closed" | "Did Not Fulfill";

export type AwardReportStatus = "Pending" | "Submitted" | "Approved" | "Skipped";

export interface Award {
  id: string;
  opportunity_id: string;
  award_status: AwardStatus;
  award_date: string | null;
  period_end_date: string | null;
  notes: string;
  reporting_frequency: string | null;
  next_report_due: string | null;
  created_at: string;
  updated_at: string;

  // Report aggregates (server-computed)
  report_total: number;
  report_done: number;
  report_overdue: number;
  next_report_date: string | null;
  next_report_status: AwardReportStatus | null;
}

export interface AwardReport {
  id: string;
  award_id: string;
  due_date: string;
  status: AwardReportStatus;
  submitted_at: string | null;
  submitted_by_email: string | null;
  notes: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

async function fetchAwards(status?: AwardStatus): Promise<Award[]> {
  const path = status
    ? `/api/awards?status=${encodeURIComponent(status)}`
    : "/api/awards";
  const { data } = await api.get<Award[]>(path);
  return data;
}

export function useAwards(status?: AwardStatus) {
  return useQuery({
    queryKey: ["awards", status ?? "all"],
    queryFn: () => fetchAwards(status),
    staleTime: 60_000,
  });
}

export function useAward(awardId: string | null | undefined) {
  return useQuery({
    queryKey: ["award", awardId],
    queryFn: async () => {
      const { data } = await api.get<Award>(`/api/awards/${awardId}`);
      return data;
    },
    enabled: !!awardId,
    staleTime: 30_000,
  });
}

export interface AwardPatch {
  award_status?: AwardStatus;
  period_end_date?: string | null;
  notes?: string;
  reporting_frequency?: string | null;
  next_report_due?: string | null;
}

export function useUpdateAward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: AwardPatch }) => {
      const { data } = await api.patch<Award>(`/api/awards/${id}`, patch);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

// ── Reports ───────────────────────────────────────────────────────────────

export function useAwardReports(awardId: string | null) {
  return useQuery({
    queryKey: ["award-reports", awardId],
    queryFn: async () => {
      const { data } = await api.get<AwardReport[]>(`/api/awards/${awardId}/reports`);
      return data;
    },
    enabled: !!awardId,
    staleTime: 30_000,
  });
}

export interface AwardReportPatch {
  due_date?: string;
  status?: AwardReportStatus;
  submitted_at?: string | null;
  notes?: string;
  sort_order?: number;
}

export function useCreateAwardReport(awardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { due_date: string; status?: AwardReportStatus; notes?: string }) => {
      const { data } = await api.post<AwardReport>(`/api/awards/${awardId}/reports`, body);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-reports", awardId] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export function useUpdateAwardReport(awardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: AwardReportPatch }) => {
      const { data } = await api.patch<AwardReport>(`/api/awards/reports/${id}`, patch);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-reports", awardId] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export function useDeleteAwardReport(awardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/awards/reports/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-reports", awardId] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export function useGenerateAwardSchedule(awardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<AwardReport[]>(`/api/awards/${awardId}/reports/generate`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-reports", awardId] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}
