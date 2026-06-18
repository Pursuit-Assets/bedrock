/**
 * Renders jobs ActivityEntry rows (emails, meetings, calls, logged touches),
 * used by the account/contact expand panels and detail pages.
 *
 * - Client-side search.
 * - Jobs-logged touches (call/text/linkedin) are separated from synced
 *   email/calendar.
 * - Mass blasts/invites (many rows sharing subject + sender + day) collapse into
 *   ONE expandable row ("Subject · N messages") so the feed stays readable.
 * - Any row expands to the full email: From / To / timestamp / body.
 * - Fluid layout, no horizontal scroll.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

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

function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function dayKey(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

/** One activity row — expands to full email (From / To / time / body). */
function Row({ a, depth = 0 }: { a: ActivityEntry; depth?: number }) {
  const [open, setOpen] = useState(false);
  const body = decode(a.email_body_text || a.description);
  const snippet = decode(a.email_snippet || a.description);
  const to = (a.email_to ?? []).map(decode);
  const expandable = body.length > 0 || to.length > 0;
  return (
    <div className={cn("border-b border-border-strong/60 last:border-0", depth > 0 && "bg-surface-2/20")}>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn("flex w-full items-start gap-2 px-3 py-2 text-left", expandable && "cursor-pointer hover:bg-surface-2/40")}
        style={depth > 0 ? { paddingLeft: 12 + depth * 16 } : undefined}
      >
        <span className="mt-0.5 shrink-0"><ActivitySourceIcon source={a.source} type={a.type} size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{decode(a.subject) || a.type || "Activity"}</span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-4">{fmtDate(a.activity_date)}</span>
          </span>
          {a.email_from && !open && <span className="block truncate text-[11px] text-ink-4">{decode(a.email_from)}</span>}
          {!open && snippet && <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{snippet}</span>}
          {open && (
            <span className="mt-1.5 block rounded-md bg-surface-2/50 p-2 text-[11.5px] leading-relaxed text-ink-2">
              <span className="block text-[11px] text-ink-4"><span className="font-medium text-ink-3">From:</span> {decode(a.email_from) || "—"}</span>
              {to.length > 0 && <span className="block text-[11px] text-ink-4"><span className="font-medium text-ink-3">To:</span> {to.join(", ")}</span>}
              <span className="block text-[11px] text-ink-4"><span className="font-medium text-ink-3">When:</span> {fmtDateTime(a.activity_date)}</span>
              {body && <span className="mt-1.5 block whitespace-pre-wrap border-t border-border-strong/60 pt-1.5">{body}</span>}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** Collapsed blast/invite: one header row expanding to its member messages. */
function GroupRow({ subject, rows }: { subject: string; rows: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  const a = rows[0];
  const recipients = new Set<string>();
  for (const r of rows) for (const t of r.email_to ?? []) recipients.add(t.toLowerCase());
  const detail = recipients.size > 0 ? `${recipients.size} recipient${recipients.size === 1 ? "" : "s"}` : `${rows.length} messages`;
  return (
    <div className="border-b border-border-strong/60 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2/40">
        <span className="mt-0.5 shrink-0">{open ? <ChevronDown size={12} className="text-ink-3" /> : <ChevronRight size={12} className="text-ink-3" />}</span>
        <span className="mt-0.5 shrink-0"><ActivitySourceIcon source={a.source} type={a.type} size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{decode(subject) || "(no subject)"}</span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-4">{fmtDate(a.activity_date)}</span>
          </span>
          <span className="block truncate text-[11px] text-ink-4">{decode(a.email_from)} · <span className="text-accent">{rows.length} messages · {detail}</span></span>
        </span>
      </button>
      {open && <div>{rows.map((r) => <Row key={r.id} a={r} depth={1} />)}</div>}
    </div>
  );
}

type Item = { kind: "row"; a: ActivityEntry } | { kind: "group"; subject: string; rows: ActivityEntry[] };

/** Collapse comms into blast-groups (same subject+sender+day, 2+ rows). */
function groupComms(rows: ActivityEntry[]): Item[] {
  const buckets = new Map<string, ActivityEntry[]>();
  const order: string[] = [];
  for (const a of rows) {
    const k = `${(a.subject ?? "").trim().toLowerCase()}|${dayKey(a.activity_date)}|${(a.email_from ?? "").toLowerCase()}`;
    if (!buckets.has(k)) { buckets.set(k, []); order.push(k); }
    buckets.get(k)!.push(a);
  }
  return order.map((k) => {
    const rs = buckets.get(k)!;
    return rs.length >= 2 ? { kind: "group" as const, subject: rs[0].subject ?? "", rows: rs } : { kind: "row" as const, a: rs[0] };
  });
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

  const jobs = useMemo(() => filtered.filter((a) => a.is_jobs), [filtered]);
  const comms = useMemo(() => groupComms(filtered.filter((a) => !a.is_jobs)), [filtered]);

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
          {comms.map((it, i) => it.kind === "group"
            ? <GroupRow key={`g${i}`} subject={it.subject} rows={it.rows} />
            : <Row key={it.a.id} a={it.a} />)}
        </>
      )}
      {filtered.length === 0 && <div className="px-4 py-4 text-[12px] text-ink-3">No activity matches "{q}".</div>}
    </div>
  );
}
