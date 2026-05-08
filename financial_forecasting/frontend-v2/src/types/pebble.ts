/**
 * Pebble orchestrator wire types.
 *
 * Mirrors the Python schemas in:
 *   - pebble/orchestrator/chat_orchestrator.py (OrchestratorEvent)
 *   - pebble/orchestrator/schemas.py (Plan, PlanStep, FinalResponse,
 *     Citation, ChartSpec, SuggestedAction, EvalVerdict)
 *
 * Wire format (per pebble/orchestrator/sse.py): each SSE frame is
 * `data: {"kind": "<kind>", "payload": <payload>}\n\n`. The frontend
 * parses one frame at a time, branches on `kind`, and reduces into
 * `PebbleConversationState`.
 *
 * If you add a new orchestrator event server-side, add the matching
 * type here and a case in the streaming reducer in
 * `services/pebble.ts`. TypeScript's discriminated union catches missed
 * cases at compile time.
 */

// ── Eval verdict (mirrors pebble.orchestrator.schemas.EvalVerdict) ─────────
export type EvalVerdict = "pass" | "retry" | "abort";

// ── Citation (FinalResponse.citations) ─────────────────────────────────────
export interface Citation {
  cite_id: string;
  entity_type: string;       // 'sf_account', 'pebble_profile', etc.
  entity_id: string;
  title: string;
  href: string;
}

// ── ChartSpec (FinalResponse.charts) ───────────────────────────────────────
export type ChartKind = "line" | "bar" | "pie" | "area" | "scatter" | "funnel";

export interface ChartSpec {
  chart_id: string;
  kind: ChartKind;
  title: string;
  data: Array<Record<string, unknown>>;
  x_key: string | null;
  y_keys: string[];
}

// ── SuggestedAction (deferred — propose_write tool not in L1) ──────────────
export interface SuggestedAction {
  action_id: string;
  kind: string;
  payload: Record<string, unknown>;
  diff_preview: string;
  record_label: string;
  rationale: string;
}

// ── FinalResponse (response_final.payload.final) ───────────────────────────
export interface FinalResponse {
  plan_id: string;
  text: string;
  citations: Citation[];
  suggested_actions: SuggestedAction[];
  charts: ChartSpec[];
  degraded: boolean;
  degradation_reason: string | null;
}

// ── Plan event payloads (plan_emitted) ─────────────────────────────────────
export interface PlanStep {
  step_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PlanEmittedPayload {
  plan_id: string;
  rationale: string;
  steps: PlanStep[];
  estimated_tool_calls?: number;
  estimated_cost_usd?: number;
  is_replan?: boolean;
}

// ── Tool-call events ───────────────────────────────────────────────────────
export interface ToolCallStartedPayload {
  step_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolCallFinishedPayload {
  step_id: string;
  tool: string;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  cost_usd: number;
  citation_count: number;
}

// ── Eval event ─────────────────────────────────────────────────────────────
export interface EvalEmittedPayload {
  verdict: EvalVerdict;
  factuality: number;
  completeness: number;
  harm: "none" | "mild" | "severe";
  rationale: string;
}

// ── Replan event ───────────────────────────────────────────────────────────
export interface ReplanStartedPayload {
  reason: string;
  replan_index: number;
}

// ── Draft / final / error ──────────────────────────────────────────────────
export interface DraftEmittedPayload {
  draft: FinalResponse;
}

export interface ResponseFinalPayload {
  final: FinalResponse;
  replanned?: boolean;
  abort_reason?: string;
}

export interface ErrorPayload {
  phase: string;            // 'planning', 'replan', 'transport', 'proxy', 'construction', etc.
  reason?: string;
  detail?: string;
  status?: number | string;
  // arbitrary extras allowed (see pebble/orchestrator/sse.py:encode_error)
  [k: string]: unknown;
}

// ── Discriminated union ────────────────────────────────────────────────────
//
// Each event has a `kind` discriminator and a typed `payload`. The wire
// format guarantees both fields are present.

export type OrchestratorEvent =
  | { kind: "plan_emitted"; payload: PlanEmittedPayload }
  | { kind: "tool_call_started"; payload: ToolCallStartedPayload }
  | { kind: "tool_call_finished"; payload: ToolCallFinishedPayload }
  | { kind: "draft_emitted"; payload: DraftEmittedPayload }
  | { kind: "eval_emitted"; payload: EvalEmittedPayload }
  | { kind: "replan_started"; payload: ReplanStartedPayload }
  | { kind: "response_final"; payload: ResponseFinalPayload }
  | { kind: "error"; payload: ErrorPayload };

// ── Step status (FE-only, derived from event sequence) ─────────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "failed";

export interface StepView {
  step_id: string;
  tool: string;
  args: Record<string, unknown>;
  status: StepStatus;
  duration_ms?: number;
  cost_usd?: number;
  error?: string;
}

// ── Reduced conversation state ─────────────────────────────────────────────
//
// PebbleConversationContext maintains an array of these; one per turn
// the user takes. The streaming SSE consumer reduces events into the
// current turn's state.

export interface PebbleTurn {
  turn_id: string;            // client-minted UUID
  query: string;              // what the user asked
  // Streaming-time state (mutates as events arrive):
  plan?: PlanEmittedPayload;
  steps: StepView[];
  draft?: FinalResponse;       // earliest-rendered text (pre-eval)
  evaluation?: EvalEmittedPayload;
  replanned: boolean;
  // Final state (set on response_final):
  final?: FinalResponse;
  error?: ErrorPayload;
  // Bookkeeping:
  started_at: number;          // performance.now()
  finished_at?: number;
}
