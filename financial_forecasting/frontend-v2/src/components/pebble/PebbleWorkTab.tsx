import { CheckCircle2, Clock, Loader2, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  usePebbleSessions,
  type PebbleSession,
  type PebbleSessionStatus,
} from "@/services/pebbleSessions";

/**
 * Pebble Work tab — live list of active + recent research flows.
 *
 * Polls `/api/pebble/sessions` every 15s while open so in-flight flows
 * tick visibly. Each row: status pill, title, current tool, progress,
 * running cost. Done flows roll to the bottom with a completed-at
 * timestamp. The empty state preserves the original guidance copy.
 */
export function PebbleWorkTab() {
  const { data, isLoading } = usePebbleSessions();
  const sessions = data?.sessions ?? [];
  const isMock = !!data?.isMock;

  if (isLoading) {
    return <LoadingState />;
  }

  if (sessions.length === 0) {
    return <EmptyState />;
  }

  const active = sessions.filter((s) => s.status !== "done" && s.status !== "failed");
  const completed = sessions.filter((s) => s.status === "done" || s.status === "failed");

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {active.length > 0 ? (
          <Section title={`Active (${active.length})`}>
            {active.map((s) => (
              <SessionRow key={s.session_id} session={s} />
            ))}
          </Section>
        ) : null}
        {completed.length > 0 ? (
          <Section title={`Recent (${completed.length})`} muted>
            {completed.map((s) => (
              <SessionRow key={s.session_id} session={s} />
            ))}
          </Section>
        ) : null}
      </div>
      {isMock ? <MockBadge /> : null}
    </div>
  );
}

function Section({
  title,
  children,
  muted,
}: {
  title: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div>
      <div
        className={cn(
          "sticky top-0 border-b border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider",
          muted ? "text-ink-3" : "text-ink",
        )}
      >
        {title}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

function SessionRow({ session }: { session: PebbleSession }) {
  const started = new Date(session.started_at);
  const sinceMin = Math.max(0, Math.floor((Date.now() - started.getTime()) / 60000));
  const stepsLabel = session.steps_total > 0
    ? `${session.steps_done}/${session.steps_total} steps`
    : "planning…";

  return (
    <li className="flex flex-col gap-1 border-b border-border-strong px-3 py-2 last:border-b-0 hover:bg-surface-2">
      <div className="flex items-start gap-2">
        <StatusBadge status={session.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink" title={session.title}>
            {session.title}
          </div>
          <div className="mt-0.5 line-clamp-1 text-[11px] text-ink-3">
            {session.query}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6 text-[10.5px] text-ink-3">
        {session.tool_in_progress ? (
          <span className="inline-flex items-center gap-1 text-accent-ink">
            <Loader2 size={9} className="animate-spin" />
            <span className="mono">{session.tool_in_progress}</span>
          </span>
        ) : null}
        <span>{stepsLabel}</span>
        <span aria-hidden>·</span>
        <span className="mono tabular-nums">${session.cost_usd.toFixed(3)}</span>
        <span aria-hidden>·</span>
        <span>
          {session.status === "done" ? "completed " : ""}
          {sinceMin === 0 ? "just now" : `${sinceMin}m ago`}
        </span>
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: PebbleSessionStatus }) {
  const config: Record<
    PebbleSessionStatus,
    { label: string; icon: React.ReactNode; cls: string }
  > = {
    planning: {
      label: "Planning",
      icon: <Loader2 size={9} className="animate-spin" />,
      cls: "bg-amber-soft text-amber",
    },
    tool_calling: {
      label: "Working",
      icon: <Loader2 size={9} className="animate-spin" />,
      cls: "bg-accent-soft text-accent-ink",
    },
    waiting: {
      label: "Waiting",
      icon: <Clock size={9} />,
      cls: "bg-surface-2 text-ink-2",
    },
    done: {
      label: "Done",
      icon: <CheckCircle2 size={9} />,
      cls: "bg-green-soft text-green",
    },
    failed: {
      label: "Failed",
      icon: <Wrench size={9} />,
      cls: "bg-red-soft text-red",
    },
  };
  const c = config[status];
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider",
        c.cls,
      )}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2">
        <Wrench size={20} className="text-ink-3" />
      </div>
      <div className="text-[13px] font-medium text-ink">No active research flows</div>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-ink-3">
        When Pebble is working a long-running query — researching an
        account, drafting a stewardship plan, or queuing a deep-dive —
        you'll see live status here.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col gap-1 p-3" aria-busy>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-border-strong py-2">
          <div className="h-3.5 w-14 animate-pulse rounded bg-surface-2" />
          <div className="flex-1 space-y-1">
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function MockBadge() {
  return (
    <div className="border-t border-border-strong bg-surface-2 px-3 py-1.5 text-center text-[10px] text-ink-3">
      Showing mock sessions · live data when{" "}
      <code className="rounded bg-surface px-1">PEBBLE_REAL_ENGINE=true</code>
    </div>
  );
}
