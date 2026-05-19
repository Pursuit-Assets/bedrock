import { Wrench } from "lucide-react";

/**
 * Pebble Work tab — surfaces in-flight background research flows.
 *
 * Placeholder for now. When the engine ships a `/api/pebble/sessions`
 * endpoint (or pushes flow status to a SSE channel), this tab renders
 * each active session as a row:
 *
 *   • Title / first query
 *   • Status (planning, tool-calling, waiting, done)
 *   • Cost so far
 *   • Open → restores the full conversation
 *
 * For first cut: a clearly-labeled empty state. The placeholder makes
 * the eventual swap one-file (`PlaceholderState` → real list view).
 */
export function PebbleWorkTab() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2">
        <Wrench size={20} className="text-ink-3" />
      </div>
      <div className="text-[13px] font-medium text-ink">No active research flows</div>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-ink-3">
        When Pebble is working a long-running query — researching an
        account, drafting a stewardship plan, or queuing a deep-dive —
        you'll see live status here. Background tasks survive across
        tabs and route changes.
      </p>
      <div className="rounded border border-dashed border-border-strong bg-surface-2 px-2 py-1 text-[10.5px] text-ink-3">
        Hooks in once <code className="rounded bg-surface px-1">/api/pebble/sessions</code> ships.
      </div>
    </div>
  );
}
