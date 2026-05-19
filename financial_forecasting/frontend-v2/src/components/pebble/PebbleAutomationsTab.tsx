import { useState } from "react";
import { Check, ExternalLink, Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import {
  useApprovePebbleAutomation,
  usePebbleAutomations,
  useRejectPebbleAutomation,
  type PebbleAutomation,
} from "@/services/pebbleSessions";

/**
 * Pebble Automations tab — propose_write review queue.
 *
 * Each card surfaces a suggested write (stage update / task create /
 * amount change) with a diff preview and Pebble's rationale. Approve
 * → POST /api/pebble/automations/:id/approve. Reject → :id/reject.
 * Both invalidate the query so the card disappears from the list on
 * success. Confidence badge gives a one-glance read on Pebble's
 * conviction.
 */
export function PebbleAutomationsTab() {
  const { data, isLoading } = usePebbleAutomations();
  const items = data?.automations ?? [];
  const isMock = !!data?.isMock;

  if (isLoading) {
    return <LoadingState />;
  }

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2">
        {items.map((a) => (
          <AutomationCard key={a.action_id} automation={a} />
        ))}
      </div>
      {isMock ? <MockBadge /> : null}
    </div>
  );
}

function AutomationCard({ automation }: { automation: PebbleAutomation }) {
  const approve = useApprovePebbleAutomation();
  const reject = useRejectPebbleAutomation();
  const [acting, setActing] = useState<null | "approve" | "reject">(null);

  const onApprove = async () => {
    setActing("approve");
    try {
      await approve.mutateAsync(automation.action_id);
      toast.success(`Approved · ${automation.record_label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setActing(null);
    }
  };

  const onReject = async () => {
    setActing("reject");
    try {
      await reject.mutateAsync(automation.action_id);
      toast.success(`Rejected · ${automation.record_label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="mb-2 rounded-md border border-border-strong bg-surface text-[11.5px] shadow-sm last:mb-0">
      <header className="flex items-start justify-between gap-2 border-b border-border-strong bg-surface-2 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <KindBadge kind={automation.kind} />
          <div className="mt-1 flex min-w-0 items-center gap-1">
            {automation.record_href ? (
              <Link
                to={automation.record_href}
                className="truncate text-[12px] font-medium text-accent-ink hover:underline"
                title={automation.record_label}
              >
                {automation.record_label}
              </Link>
            ) : (
              <span className="truncate text-[12px] font-medium text-ink">
                {automation.record_label}
              </span>
            )}
            {automation.record_href ? (
              <ExternalLink size={9} className="flex-shrink-0 text-ink-4" />
            ) : null}
          </div>
        </div>
        <ConfidenceBadge value={automation.confidence} />
      </header>

      <pre className="overflow-x-auto whitespace-pre-wrap break-words border-b border-border-strong bg-surface px-2.5 py-2 font-mono text-[11px] leading-snug text-ink">
        {automation.diff_preview}
      </pre>

      <div className="px-2.5 py-1.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Why
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-2">
          {automation.rationale}
        </p>
      </div>

      <footer className="flex items-center justify-between border-t border-border-strong bg-surface-2 px-2.5 py-1.5">
        <span className="text-[10px] text-ink-3">
          Proposed {formatRel(automation.proposed_at)}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onReject}
            disabled={acting !== null}
            className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
          >
            <X size={10} /> Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={acting !== null}
            className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-ink disabled:opacity-50"
          >
            <Check size={10} /> Approve
          </button>
        </div>
      </footer>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const label = kind.replace(/_/g, " ");
  return (
    <span className="inline-flex items-center rounded bg-accent-soft px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-accent-ink">
      {label}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 85 ? "green" : pct >= 65 ? "amber" : "red";
  return (
    <span
      className={cn(
        "mono inline-flex items-center rounded px-1.5 py-px text-[9.5px] font-semibold tabular-nums",
        tone === "green" && "bg-green-soft text-green",
        tone === "amber" && "bg-amber-soft text-amber",
        tone === "red" && "bg-red-soft text-red",
      )}
      title="Pebble's confidence in the proposed write"
    >
      {pct}%
    </span>
  );
}

function formatRel(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2">
        <Inbox size={20} className="text-ink-3" />
      </div>
      <div className="text-[13px] font-medium text-ink">Inbox zero</div>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-ink-3">
        When Pebble proposes a write — updating a Stage, drafting a task,
        creating an Award — it lands here for your approval. Nothing
        hits Salesforce without a human in the loop.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col gap-2 p-2" aria-busy>
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          className="space-y-2 rounded-md border border-border-strong bg-surface p-2.5"
        >
          <div className="h-3 w-1/3 animate-pulse rounded bg-surface-2" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
          <div className="h-12 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function MockBadge() {
  return (
    <div className="border-t border-border-strong bg-surface-2 px-3 py-1.5 text-center text-[10px] text-ink-3">
      Mock automations · live queue when{" "}
      <code className="rounded bg-surface px-1">PEBBLE_REAL_ENGINE=true</code>
    </div>
  );
}
