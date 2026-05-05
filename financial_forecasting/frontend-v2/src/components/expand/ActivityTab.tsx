import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { ActivitySourceIcon } from "@/components/ActivitySourceIcon";
import { useActivities, type ActivityFilters } from "@/services/activities";
import { useAccounts } from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BedrockActivity } from "@/types/salesforce";

function isEmailOrMeeting(a: BedrockActivity): boolean {
  const t = (a.type ?? "").toLowerCase();
  const s = (a.source ?? "").toLowerCase();
  return (
    t === "email" ||
    t === "meeting" ||
    t === "calendar-event" ||
    t === "calendar" ||
    t === "event" ||
    s.includes("gmail") ||
    s.includes("calendar") ||
    s.includes("fireflies")
  );
}

export function ActivityTab({
  filters,
  emptyMessage = "No activity yet.",
  limit = 100,
}: {
  filters: ActivityFilters;
  emptyMessage?: string;
  limit?: number;
}) {
  const { data: raw = [], isLoading } = useActivities({ limit, ...filters });

  const activities = useMemo(() => raw.filter(isEmailOrMeeting), [raw]);

  const { data: opps = [] } = useOpportunities();
  const { data: accounts = [] } = useAccounts();

  const oppNames = useMemo(
    () => new Map(opps.map((o) => [o.Id, o.Name] as const)),
    [opps],
  );
  const accountNames = useMemo(
    () => new Map(accounts.map((a) => [a.Id, a.Name] as const)),
    [accounts],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-strong px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {isLoading ? "Activity (…)" : `Activity (${activities.length})`}
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="px-5 py-4 text-center text-[12px] text-ink-3">Loading activity…</div>
        ) : activities.length === 0 ? (
          <div className="px-5 py-4 text-center text-[12px] text-ink-3">{emptyMessage}</div>
        ) : (
          <ul className="flex flex-col">
            {activities.map((a) => (
              <ActivityRow
                key={a.id}
                a={a}
                oppNames={oppNames}
                accountNames={accountNames}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActivityRow({
  a,
  oppNames,
  accountNames,
}: {
  a: BedrockActivity;
  oppNames: Map<string, string>;
  accountNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);

  const dateStr = fmtDate(a.occurred_at ?? a.activity_date ?? a.created_at ?? null);
  const subject = a.subject ?? a.email_snippet ?? "(no subject)";

  const contextName =
    a._context_name ??
    (a.opportunity_id ? oppNames.get(a.opportunity_id) : null) ??
    (a.account_id ? accountNames.get(a.account_id) : null) ??
    null;

  const isMeeting =
    ["meeting", "calendar-event", "calendar", "event"].includes(
      (a.type ?? "").toLowerCase(),
    ) || (a.source ?? "").toLowerCase().includes("calendar") || (a.source ?? "").toLowerCase().includes("fireflies");

  // Detail content — what to show when expanded
  const hasDetail =
    !!(a.description && a.description !== a.subject) ||
    !!a.email_snippet ||
    !!a.meeting_duration_minutes ||
    !!a.meeting_location;

  return (
    <li className="border-b border-border-strong last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-2 text-left",
          hasDetail && "cursor-pointer hover:bg-surface-2/50",
          !hasDetail && "cursor-default",
        )}
      >
        <span className="mt-0.5 flex-shrink-0 text-ink-4">
          {hasDetail ? (
            open ? <ChevronDown size={11} /> : <ChevronRight size={11} />
          ) : (
            <span className="w-[11px]" />
          )}
        </span>
        <span className="mt-0.5 flex-shrink-0">
          <ActivitySourceIcon source={a.source} type={a.type} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-ink" title={subject}>
            {subject}
          </span>
          {contextName ? (
            <span className="block truncate text-[10.5px] text-ink-3">
              {contextName}
            </span>
          ) : null}
        </span>
        <span className="flex-shrink-0 text-right">
          <span className="mono text-[11px] text-ink-3">{dateStr}</span>
        </span>
      </button>

      {open && hasDetail ? (
        <div className="border-t border-border-strong bg-surface-2/40 px-4 py-2.5 text-[12px]">
          {isMeeting && (a.meeting_duration_minutes || a.meeting_location) ? (
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              {a.meeting_duration_minutes ? (
                <span>{a.meeting_duration_minutes} min</span>
              ) : null}
              {a.meeting_location ? <span>{a.meeting_location}</span> : null}
            </div>
          ) : null}
          {a.description && a.description !== a.subject ? (
            <p className="whitespace-pre-wrap text-[12px] text-ink-2">
              {a.description}
            </p>
          ) : a.email_snippet && a.email_snippet !== a.subject ? (
            <p className="whitespace-pre-wrap text-[12px] italic text-ink-2">
              {a.email_snippet}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
