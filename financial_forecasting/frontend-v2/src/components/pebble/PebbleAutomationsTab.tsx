import { Inbox } from "lucide-react";

/**
 * Pebble Automations tab — review queue for Pebble's suggested writes.
 *
 * Placeholder. The full version (when `propose_write` + JWT confirm
 * land per the PR #184 roadmap) lists each suggested action with:
 *
 *   • Record + field
 *   • Diff preview (before → after)
 *   • Rationale (Pebble's why)
 *   • Approve / Reject / Edit before approving
 *
 * Until then, this tab makes the seam visible — Pebble can suggest,
 * but a human reviews. That's the contract.
 */
export function PebbleAutomationsTab() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2">
        <Inbox size={20} className="text-ink-3" />
      </div>
      <div className="text-[13px] font-medium text-ink">No automations to review</div>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-ink-3">
        When Pebble proposes a write — updating a Stage, drafting a
        task, creating an Award — it lands here for your approval first.
        Nothing hits Salesforce without a human in the loop.
      </p>
      <div className="rounded border border-dashed border-border-strong bg-surface-2 px-2 py-1 text-[10.5px] text-ink-3">
        Hooks in once <code className="rounded bg-surface px-1">propose_write</code> + JWT confirm ship.
      </div>
    </div>
  );
}
