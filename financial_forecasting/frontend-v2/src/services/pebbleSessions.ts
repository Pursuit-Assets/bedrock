/**
 * Pebble sessions + automations — list views for the Work and
 * Automations tabs of the floating box.
 *
 * Backend lives in `financial_forecasting/routes/pebble_mock.py` while
 * the real engine is still in flight. Same env gate
 * (PEBBLE_REAL_ENGINE=true) flips both routes to the production
 * implementation; the frontend hooks don't change.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// ── Sessions ──────────────────────────────────────────────────────

export type PebbleSessionStatus =
  | "planning"
  | "tool_calling"
  | "waiting"
  | "done"
  | "failed";

export interface PebbleSession {
  session_id: string;
  title: string;
  query: string;
  status: PebbleSessionStatus;
  tool_in_progress?: string | null;
  started_at: string;
  completed_at?: string;
  cost_usd: number;
  steps_done: number;
  steps_total: number;
}

interface SessionsResponse {
  data: PebbleSession[];
  mock?: boolean;
}

async function fetchPebbleSessions(): Promise<{
  sessions: PebbleSession[];
  isMock: boolean;
}> {
  try {
    const { data } = await api.get<SessionsResponse>("/api/pebble/sessions");
    return { sessions: data?.data ?? [], isMock: !!data?.mock };
  } catch {
    return { sessions: [], isMock: false };
  }
}

export function usePebbleSessions() {
  return useQuery({
    queryKey: ["pebble-sessions"],
    queryFn: fetchPebbleSessions,
    staleTime: 30_000,
    refetchInterval: 15_000, // gentle polling so in-flight flows tick
    retry: false,
  });
}

// ── Automations ───────────────────────────────────────────────────

export interface PebbleAutomation {
  action_id: string;
  kind: string;
  record_label: string;
  record_href?: string;
  diff_preview: string;
  rationale: string;
  proposed_at: string;
  confidence: number;
}

interface AutomationsResponse {
  data: PebbleAutomation[];
  mock?: boolean;
}

async function fetchPebbleAutomations(): Promise<{
  automations: PebbleAutomation[];
  isMock: boolean;
}> {
  try {
    const { data } = await api.get<AutomationsResponse>(
      "/api/pebble/automations",
    );
    return { automations: data?.data ?? [], isMock: !!data?.mock };
  } catch {
    return { automations: [], isMock: false };
  }
}

export function usePebbleAutomations() {
  return useQuery({
    queryKey: ["pebble-automations"],
    queryFn: fetchPebbleAutomations,
    staleTime: 60_000,
    retry: false,
  });
}

export function useApprovePebbleAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (actionId: string) => {
      const { data } = await api.post<{ ok: boolean }>(
        `/api/pebble/automations/${encodeURIComponent(actionId)}/approve`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pebble-automations"] });
    },
  });
}

export function useRejectPebbleAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (actionId: string) => {
      const { data } = await api.post<{ ok: boolean }>(
        `/api/pebble/automations/${encodeURIComponent(actionId)}/reject`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pebble-automations"] });
    },
  });
}
