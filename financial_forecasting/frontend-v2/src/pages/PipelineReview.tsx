/**
 * Pipeline Review — weekly meeting dashboard.
 *
 * Purpose: single page the team runs the weekly pipeline meeting from.
 * Sales leader skims new developments (15 min). Each RM walks through
 * priority accounts (45 min — switch the RM filter for their turn).
 * Live task logging during the meeting via the bottom-of-page form.
 *
 * Sections (top → bottom):
 *   1. Header — week selector + RM filter + quick-task focus
 *   2. Recent opportunity changes (stage / amount / probability / close)
 *   3. Meetings — upcoming next 7d + recent past 7d
 *   4. Activity feed — combined chronological from bedrock.activity
 *   5. Quick task entry — inline form, posts to SF directly
 */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Mail,
  MessageSquare,
  Phone,
  TrendingUp,
  User,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/format";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/services/auth";
import { useActivityFeed } from "@/services/activities";
import { useAccounts } from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import {
  useOpportunityChanges,
  type OpportunityChange,
} from "@/services/pipelineReview";
import { useActiveUsers } from "@/services/users";
import type { BedrockActivity } from "@/types/salesforce";

// ── Helpers ────────────────────────────────────────────────────────────────

function isoStart(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}
function isoEnd(d: Date): string {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffSec = (Date.now() - t) / 1000;
  if (Math.abs(diffSec) < 60) return diffSec < 0 ? "in <1m" : "just now";
  const abs = Math.abs(diffSec);
  const past = diffSec >= 0;
  if (abs < 3600) {
    const m = Math.round(abs / 60);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86400) {
    const h = Math.round(abs / 3600);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86400);
  return past ? `${d}d ago` : `in ${d}d`;
}

function fmtChangeValue(field: string, val: unknown): string {
  if (val == null || val === "") return "—";
  if (field === "Amount") {
    const n = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(n)) return fmtMoney(n);
    return String(val);
  }
  if (field === "Probability") {
    const n = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(n)) return `${n}%`;
    return String(val);
  }
  if (field === "CloseDate") {
    return fmtDate(String(val));
  }
  return String(val);
}

function fieldLabel(field: string): string {
  if (field === "StageName") return "Stage";
  if (field === "CloseDate") return "Close date";
  return field;
}

// ── Page ───────────────────────────────────────────────────────────────────

export function PipelineReviewPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const usersQ = useActiveUsers();
  const meQ = useCurrentUser();

  // Monday → Sunday week boundaries.
  const weekRange = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset + weekOffset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { monday, sunday };
  }, [weekOffset]);

  const weekLabel = useMemo(() => {
    const { monday, sunday } = weekRange;
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const sameMonth = monday.getMonth() === sunday.getMonth();
    return sameMonth
      ? `${fmt(monday)} – ${sunday.getDate()}`
      : `${fmt(monday)} – ${fmt(sunday)}`;
  }, [weekRange]);

  const isCurrentWeek = weekOffset === 0;
  const windowDays = 7;

  const changesQ = useOpportunityChanges({ days: windowDays, ownerId });

  // Meetings: upcoming (now → +7d) and recent (-7d → now). Fixed
  // around "now" regardless of weekOffset, since the meeting brief
  // is "what's coming this week and what just happened". The week
  // selector controls only the changes + feed.
  const nowIso = useMemo(() => new Date().toISOString(), []);
  const sevenDaysAgoIso = useMemo(
    () => new Date(Date.now() - 7 * 86400_000).toISOString(),
    [],
  );
  const sevenDaysAheadIso = useMemo(
    () => new Date(Date.now() + 7 * 86400_000).toISOString(),
    [],
  );

  const upcomingMeetingsQ = useActivityFeed({
    ownerId,
    type: "meeting",
    startDate: nowIso,
    endDate: sevenDaysAheadIso,
    limit: 50,
  });
  const recentMeetingsQ = useActivityFeed({
    ownerId,
    type: "meeting",
    startDate: sevenDaysAgoIso,
    endDate: nowIso,
    limit: 50,
  });

  const feedQ = useActivityFeed({
    ownerId,
    startDate: isoStart(weekRange.monday),
    endDate: isoEnd(weekRange.sunday),
    limit: 150,
  });

  const ownerLabel = useMemo(() => {
    if (!ownerId) return "Whole team";
    return (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? "Unknown";
  }, [ownerId, usersQ.data]);

  const quickTaskRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <PageHeader
        title="Pipeline Review"
        subtitle={`Weekly meeting · ${weekLabel} · ${ownerLabel}`}
        actions={
          <button
            type="button"
            onClick={() => quickTaskRef.current?.focus()}
            className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90"
          >
            <ClipboardList size={14} /> Log task
          </button>
        }
      />

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border-strong bg-surface px-3 py-2">
        <div className="inline-flex items-center rounded-md border border-border-strong">
          <button
            type="button"
            onClick={() => setWeekOffset((w) => w - 1)}
            className="grid h-7 w-7 place-items-center text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Previous week"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset(0)}
            className={cn(
              "h-7 px-3 text-[12px] font-medium border-x border-border-strong",
              isCurrentWeek ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2",
            )}
            title="Jump to this week"
          >
            {weekLabel}
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset((w) => w + 1)}
            className="grid h-7 w-7 place-items-center text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Next week"
          >
            <ChevronRight size={13} />
          </button>
        </div>

        <div className="inline-flex items-center gap-1.5">
          <User size={12} className="text-ink-3" aria-hidden />
          <select
            value={ownerId ?? ""}
            onChange={(e) => setOwnerId(e.target.value || null)}
            className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent"
          >
            <option value="">Whole team</option>
            {meQ.data?.salesforce_user_id ? (
              <option value={meQ.data.salesforce_user_id}>Me</option>
            ) : null}
            <option disabled>──────</option>
            {(usersQ.data ?? [])
              .slice()
              .sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? ""))
              .map((u) => (
                <option key={u.Id} value={u.Id}>
                  {u.Name}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Recent opportunity changes" subtitle={`Last ${windowDays} days`}>
          {changesQ.isLoading ? (
            <Empty>Loading…</Empty>
          ) : (changesQ.data ?? []).length === 0 ? (
            <Empty>
              No stage / amount / probability / close-date changes in the last {windowDays} days
              {ownerId ? " for the selected RM" : ""}.
            </Empty>
          ) : (
            <ul className="flex flex-col divide-y divide-border-strong">
              {(changesQ.data ?? []).map((row) => (
                <li key={row.opportunity_id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <Link
                      to={`/opportunities/${row.opportunity_id}`}
                      className="truncate text-[13px] font-semibold text-ink hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="flex-shrink-0 text-[10.5px] text-ink-3">
                      {relativeTime(row.last_change_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2 text-[11px] text-ink-3">
                    {row.account_name ? (
                      <Link
                        to={row.account_id ? `/accounts/${row.account_id}` : "#"}
                        className="truncate hover:underline"
                      >
                        {row.account_name}
                      </Link>
                    ) : null}
                    {row.owner_name ? (
                      <span className="ml-auto flex-shrink-0">Owner: {row.owner_name}</span>
                    ) : null}
                  </div>
                  <ul className="mt-2 flex flex-col gap-1">
                    {row.changes.map((c, i) => (
                      <ChangeLine key={i} change={c} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Meetings" subtitle="Past & upcoming 7 days">
          <div className="grid grid-cols-1 divide-y divide-border-strong">
            <div className="px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                <Calendar size={11} aria-hidden /> Upcoming
              </div>
              <MeetingsList q={upcomingMeetingsQ} emptyHint="No upcoming meetings." />
            </div>
            <div className="px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                <Calendar size={11} aria-hidden /> Recent
              </div>
              <MeetingsList q={recentMeetingsQ} emptyHint="No recent meetings." />
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="Activity feed"
        subtitle={`Week of ${weekLabel}${ownerId ? "" : " · whole team"}`}
        className="mt-5"
      >
        <ActivityFeedList q={feedQ} />
      </Card>

      <Card
        title="Log a task"
        subtitle="During the meeting → straight into Salesforce"
        className="mt-5"
      >
        <QuickTaskForm
          inputRef={quickTaskRef}
          defaultOwnerId={meQ.data?.salesforce_user_id ?? null}
        />
      </Card>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-lg border border-border-strong bg-surface shadow-sm",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border-strong px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {subtitle ? <span className="text-[11px] text-ink-3">{subtitle}</span> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-[12px] text-ink-3">{children}</div>;
}

function ChangeLine({ change }: { change: OpportunityChange }) {
  const field = fieldLabel(change.field);
  const from = fmtChangeValue(change.field, change.from);
  const to = fmtChangeValue(change.field, change.to);
  let toneClass = "text-ink-2";
  if (change.field === "Amount" || change.field === "Probability") {
    const f = Number(change.from);
    const t = Number(change.to);
    if (Number.isFinite(f) && Number.isFinite(t)) {
      if (t > f) toneClass = "text-green";
      else if (t < f) toneClass = "text-red";
    }
  }
  return (
    <li className="flex items-baseline gap-1.5 text-[11.5px]">
      <span className="text-ink-3">{field}:</span>
      <span className="text-ink-3">{from}</span>
      <ArrowRight size={10} aria-hidden className="text-ink-4" />
      <span className={cn("font-medium", toneClass)}>{to}</span>
      {change.by_name ? (
        <span className="ml-auto flex-shrink-0 text-[10.5px] text-ink-3">
          by {change.by_name}
        </span>
      ) : null}
    </li>
  );
}

function MeetingsList({
  q,
  emptyHint,
}: {
  q: ReturnType<typeof useActivityFeed>;
  emptyHint: string;
}) {
  if (q.isLoading) return <div className="text-[11.5px] text-ink-3">Loading…</div>;
  const items = q.data ?? [];
  if (items.length === 0) {
    return <div className="text-[11.5px] text-ink-3">{emptyHint}</div>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.slice(0, 8).map((a) => (
        <li key={a.id}>
          <ActivityRow a={a} compact />
        </li>
      ))}
    </ul>
  );
}

function ActivityFeedList({ q }: { q: ReturnType<typeof useActivityFeed> }) {
  if (q.isLoading) return <Empty>Loading activity…</Empty>;
  const items = q.data ?? [];
  if (items.length === 0) {
    return <Empty>No activity in this window.</Empty>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border-strong">
      {items.map((a) => (
        <li key={a.id} className="px-4 py-2.5">
          <ActivityRow a={a} />
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ a, compact }: { a: BedrockActivity; compact?: boolean }) {
  const icon = activityIcon(a.type);
  const when = a.activity_date ? relativeTime(a.activity_date) : "";
  const fullWhen = a.activity_date ? fmtDate(a.activity_date) : "";
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2",
        compact ? "text-[11.5px]" : "text-[12.5px]",
      )}
    >
      <span className="mt-0.5 flex-shrink-0 text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate font-medium text-ink-2">
            {a.subject || "(no subject)"}
          </span>
          <span
            className="ml-auto flex-shrink-0 text-[10.5px] text-ink-3"
            title={fullWhen}
          >
            {when}
          </span>
        </div>
        {!compact && (a.email_snippet || a.description) ? (
          <div className="mt-0.5 line-clamp-1 text-[11px] text-ink-3">
            {a.email_snippet || a.description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function activityIcon(type: string) {
  switch (type) {
    case "email":
      return <Mail size={12} aria-hidden />;
    case "meeting":
    case "calendar-event":
      return <Calendar size={12} aria-hidden />;
    case "call":
      return <Phone size={12} aria-hidden />;
    case "note":
      return <MessageSquare size={12} aria-hidden />;
    case "slack-message":
      return <MessageSquare size={12} aria-hidden />;
    default:
      return <TrendingUp size={12} aria-hidden />;
  }
}

// ── Quick task form ────────────────────────────────────────────────────────

function QuickTaskForm({
  inputRef,
  defaultOwnerId,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  defaultOwnerId: string | null;
}) {
  const usersQ = useActiveUsers();
  const accountsQ = useAccounts();
  const oppsQ = useOpportunities();
  const qc = useQueryClient();

  const [subject, setSubject] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(defaultOwnerId);
  const [whatId, setWhatId] = useState<string | null>(null);
  const [priority, setPriority] = useState<"Normal" | "High" | "Low">("Normal");

  const relatedOptions = useMemo(() => {
    type Opt = { value: string; label: string; group: "Opportunity" | "Account" };
    const out: Opt[] = [];
    for (const o of oppsQ.data ?? []) {
      if (o.IsClosed) continue;
      const label = o.Account?.Name ? `${o.Name} — ${o.Account.Name}` : o.Name;
      out.push({ value: o.Id, label, group: "Opportunity" });
    }
    for (const a of accountsQ.data ?? []) {
      out.push({ value: a.Id, label: a.Name, group: "Account" });
    }
    return out;
  }, [oppsQ.data, accountsQ.data]);

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        Subject: subject.trim(),
        Status: "Not Started",
        Priority: priority,
      };
      if (dueDate) body.ActivityDate = dueDate;
      if (ownerId) body.OwnerId = ownerId;
      if (whatId) body.WhatId = whatId;
      const { data } = await api.post<{ success: boolean; data: { id: string } }>(
        "/api/salesforce/tasks",
        body,
      );
      return data.data.id;
    },
    onSuccess: () => {
      setSubject("");
      setDueDate("");
      setWhatId(null);
      setPriority("Normal");
      qc.invalidateQueries({ queryKey: ["activity-feed"] });
      qc.invalidateQueries({ queryKey: ["pipeline-review"] });
      toast.success("Task logged");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to log task");
    },
  });

  const canSubmit = subject.trim().length > 0 && !create.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) create.mutate();
      }}
      className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_140px_180px_180px_120px_auto]"
    >
      <input
        ref={inputRef}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Task subject…"
        aria-label="Subject"
        className="h-8 rounded-md border border-border-strong bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent"
      />
      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        aria-label="Due date"
        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
      />
      <select
        value={ownerId ?? ""}
        onChange={(e) => setOwnerId(e.target.value || null)}
        aria-label="Owner"
        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value="">— Owner —</option>
        {(usersQ.data ?? [])
          .slice()
          .sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? ""))
          .map((u) => (
            <option key={u.Id} value={u.Id}>
              {u.Name}
            </option>
          ))}
      </select>
      <select
        value={whatId ?? ""}
        onChange={(e) => setWhatId(e.target.value || null)}
        aria-label="Related to"
        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value="">— Related —</option>
        <optgroup label="Opportunities">
          {relatedOptions
            .filter((o) => o.group === "Opportunity")
            .slice(0, 200)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </optgroup>
        <optgroup label="Accounts">
          {relatedOptions
            .filter((o) => o.group === "Account")
            .slice(0, 200)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </optgroup>
      </select>
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as "Normal" | "High" | "Low")}
        aria-label="Priority"
        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value="High">High</option>
        <option value="Normal">Normal</option>
        <option value="Low">Low</option>
      </select>
      <button
        type="submit"
        disabled={!canSubmit}
        className="h-8 rounded-md bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
      >
        {create.isPending ? "Saving…" : "Add"}
      </button>
    </form>
  );
}
