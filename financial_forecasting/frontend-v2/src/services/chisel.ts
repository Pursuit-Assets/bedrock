/**
 * Service hooks for the ``/api/chisel/*`` GUI surface (Phase C).
 *
 * The Bedrock backend proxies these calls to the Pebble service via
 * ``routes/chisel_proxy.py`` so the frontend talks to one origin.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shapes — mirror pebble/chisel/service.py
// ---------------------------------------------------------------------------

export interface ChiselUnit {
  kind: "tool" | "workflow";
  name: string;
  version: string;
  description: string;
  tags: string[];
  cost_estimate_usd: number;
  requires_human: boolean;
  manifest_path: string;
  handler_path: string | null;
  has_canonical_queries: boolean;
  slash_command?: string | null;
  dispatch_intent?: string | null;
  has_custom_plan?: boolean;
  load_error?: string | null;
}

export interface ChiselDetail {
  unit: ChiselUnit;
  manifest_yaml: string;
  handler_source: string | null;
  build_plan_source: string | null;
  canonical_queries_yaml: string | null;
  input_schema: Record<string, unknown> | null;
}

export interface ChiselHealth {
  loaded_tools: string[];
  loaded_workflows: string[];
  errors: [string, string][];
  lint_warnings: [string, string][];
  ok: boolean;
}

export interface ValidationIssue {
  location: string;
  message: string;
  type: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface EvalResultEntry {
  query_id: string;
  unit: string;
  source: string;
  passed: boolean;
  skipped: boolean;
  skip_reason: string | null;
  plan_failures: string[];
  prose_failures: string[];
  planner_error: string | null;
  duration_ms: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: EvalResultEntry[];
  text_report: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const KEY = {
  health: ["chisel", "health"] as const,
  tools: ["chisel", "tools"] as const,
  tool: (name: string) => ["chisel", "tools", name] as const,
  workflows: ["chisel", "workflows"] as const,
  workflow: (name: string) => ["chisel", "workflows", name] as const,
};

export function useChiselHealth() {
  return useQuery({
    queryKey: KEY.health,
    queryFn: async (): Promise<ChiselHealth> => {
      const { data } = await api.get<ChiselHealth>("/api/chisel/health");
      return data;
    },
    staleTime: 30_000,
  });
}

export function useChiselTools() {
  return useQuery({
    queryKey: KEY.tools,
    queryFn: async (): Promise<ChiselUnit[]> => {
      const { data } = await api.get<{ tools: ChiselUnit[] }>("/api/chisel/tools");
      return data.tools;
    },
    staleTime: 30_000,
  });
}

export function useChiselTool(name: string | null | undefined) {
  return useQuery({
    queryKey: name ? KEY.tool(name) : ["chisel", "tools", "__none__"],
    enabled: !!name,
    queryFn: async (): Promise<ChiselDetail> => {
      const { data } = await api.get<ChiselDetail>(`/api/chisel/tools/${name}`);
      return data;
    },
  });
}

export function useChiselWorkflows() {
  return useQuery({
    queryKey: KEY.workflows,
    queryFn: async (): Promise<ChiselUnit[]> => {
      const { data } = await api.get<{ workflows: ChiselUnit[] }>("/api/chisel/workflows");
      return data.workflows;
    },
    staleTime: 30_000,
  });
}

export function useChiselWorkflow(name: string | null | undefined) {
  return useQuery({
    queryKey: name ? KEY.workflow(name) : ["chisel", "workflows", "__none__"],
    enabled: !!name,
    queryFn: async (): Promise<ChiselDetail> => {
      const { data } = await api.get<ChiselDetail>(`/api/chisel/workflows/${name}`);
      return data;
    },
  });
}

export function useChiselReload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ChiselHealth> => {
      const { data } = await api.post<ChiselHealth>("/api/chisel/reload");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chisel"] });
    },
  });
}

export function useChiselValidate() {
  return useMutation({
    mutationFn: async (body: {
      kind: "tool" | "workflow";
      manifest_yaml: string;
    }): Promise<ValidationResult> => {
      const { data } = await api.post<ValidationResult>("/api/chisel/validate", body);
      return data;
    },
  });
}

export function useChiselEval() {
  return useMutation({
    mutationFn: async (body: { unit?: string; tag?: string }): Promise<EvalSummary> => {
      const { data } = await api.post<EvalSummary>("/api/chisel/eval", body);
      return data;
    },
  });
}
