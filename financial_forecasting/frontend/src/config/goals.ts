/**
 * Default annual revenue goal applied when an owner has no per-owner goal
 * configured in `bedrock.owner_goal`. Admins can override by setting a
 * specific goal via the inline edit pencil on the Wall of Progress dashboard.
 */
export const DEFAULT_GOAL = 2_000_000;

/** Shape returned by GET /api/owner-goals (per sf_user_id). */
export interface OwnerGoal {
  sf_user_id: string;
  fiscal_year: number;
  goal_amount: number;
  notes: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}
