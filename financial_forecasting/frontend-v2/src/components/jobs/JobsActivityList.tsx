/**
 * Renders a list of jobs ActivityEntry rows (emails, meetings, calls, logged
 * touches). Used by the contact/account expand panels and detail pages so they
 * all show engagement the same way. Client-side search; jobs-logged touches are
 * separated from synced email/calendar.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { ActivitySourceIcon } from "@/components/ActivitySourceIcon";
import { cn } from "@/lib/utils";
import type { ActivityEntry } from "@/services/jobs";

function decode(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Row({ a }: { a: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const body = decode(a.email_body_text || a.description);
  const snippet = decode(a.email_snippet || a.description);
  const hasBody = body.length > 0;
  return (
    <div className="border-b border-border-strong/60 px-3 py-2 last:border-0">
      <button type="button" onClick={() => hasBody && setOpen((v) => !v)} className={cn("flex w-full items-start gap-2 text-left", hasBody && "cursor-pointer")}>
        <span className="mt-0.5 shrink-0"><ActivitySourceIcon source={a.source} type={a.type} size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-medium text-ink">{a.subject || a.type || "Activity"}</span>
            <span className="ml-auto shrink-0 text-[11px] text-ink-4">{fmtDate(a.activity_date)}</span>
          </span>
          {a.email_from && <span className="block truncate text-[11px] text-ink-4">{decode(a.email_from)}</span>}
          {!open && snippet && <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{snippet}</span>}
          {open && hasBody && <span className="mt-1 block whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-2">{body}</span>}
        </span>
      </button>
    </div>
  );
}

export function JobsActivityList({ entries, emptyMessage = "No activity yet." }: { entries: ActivityEntry[]; emptyMessage?: string }) {
  const [q, setQ] = useState("");
  const live = useMemo(() => entries.filter((a) => !a.deleted_at), [entries]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return live;
    return live.filter((a) =>
      [a.subject, a.description, a.email_snippet, a.email_from, ...(a.email_to ?? [])]
        .some((v) => (v ?? "").toLowerCase().includes(s)),
    );
  }, [live, q]);

  const jobs = filtered.filter((a) => a.is_jobs);
  const comms = filtered.filter((a) => !a.is_jobs);

  if (live.length === 0) return <div className="px-4 py-6 text-[12.5px] text-ink-3">{emptyMessage}</div>;

  return (
    <div className="flex flex-col">
      <div className="relative px-3 py-2">
        <Search size={12} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity…" className="h-7 w-full rounded border border-border-strong bg-surface pl-7 pr-3 text-[12px] text-ink-2 outline-none placeholder:text-ink-3 focus:border-accent" />
      </div>
      {jobs.length > 0 && (
        <>
          <div className="bg-surface-2/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Jobs touches</div>
          {jobs.map((a) => <Row key={a.id} a={a} />)}
        </>
      )}
      {comms.length > 0 && (
        <>
          <div className="bg-surface-2/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Email &amp; calendar</div>
          {comms.map((a) => <Row key={a.id} a={a} />)}
        </>
      )}
      {filtered.length === 0 && <div className="px-4 py-4 text-[12px] text-ink-3">No activity matches "{q}".</div>}
    </div>
  );
}
