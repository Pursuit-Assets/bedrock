import { useMemo, useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, Legend, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";

import { SectionCard } from "@/components/detail";
import { useActivityTrends, type ActivityTrendBucket } from "@/services/jobs";

const CHANNEL = [
  { key: "email", label: "Email", color: "#4242EA" },
  { key: "meeting", label: "Meeting", color: "#0EA5A4" },
  { key: "call", label: "Call", color: "#F59E0B" },
  { key: "other", label: "Other", color: "#CBD5E1" },
] as const;

const ACTIVATION = [
  { key: "new_contacts", label: "Contacts activated", color: "#1E1E1E" },
  { key: "new_accounts", label: "Accounts activated", color: "#FF33FF" },
] as const;

/** Period label without tz drift: "2026-05-11" → "May 11" (week) / "May" (month). */
function fmtPeriod(iso: string, gran: "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  return gran === "week" ? `${month} ${d}` : `${month} ${String(y).slice(2)}`;
}

/**
 * Outreach & Activation over time. Bars = activity VOLUME (effort, by channel),
 * lines = ACTIVATION (new contacts/accounts first-touched — the outcome).
 * Replaces the fragile single-week "New Outreach" number.
 */
export function ActivityTrends() {
  const [gran, setGran] = useState<"week" | "month">("week");
  const { data, isLoading, isError, refetch } = useActivityTrends(gran);

  const chartData = useMemo(
    () => (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({ ...b, label: fmtPeriod(b.period, gran) })),
    [data, gran],
  );

  // last-period vs prior, for a quick momentum read
  const delta = useMemo(() => {
    const b = data?.buckets ?? [];
    if (b.length < 2) return null;
    const cur = b[b.length - 1], prev = b[b.length - 2];
    return { contacts: cur.new_contacts - prev.new_contacts, prevC: prev.new_contacts };
  }, [data]);

  return (
    <SectionCard
      title="Outreach & Activation"
      storageScope="jobs"
      action={
        <div className="flex items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11.5px]">
          {(["week", "month"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGran(g)}
              className={`rounded px-2.5 py-1 font-medium capitalize ${gran === g ? "bg-ink text-surface" : "text-ink-3 hover:text-ink"}`}
            >
              {g === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2 px-5 py-10">
          <p className="text-[13px] text-red">Couldn't load activity trends.</p>
          <button type="button" onClick={() => refetch()} className="rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* summary stats */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label={`Contacts activated · ${gran === "week" ? "12 wks" : "12 mos"}`} value={data?.totals.new_contacts ?? 0}
                  sub={delta ? `${delta.contacts >= 0 ? "+" : ""}${delta.contacts} vs prior ${gran}` : undefined}
                  up={delta ? delta.contacts >= 0 : undefined} />
            <Stat label="Accounts activated" value={data?.totals.new_accounts ?? 0} />
            <Stat label="Total touchpoints" value={data?.totals.touchpoints ?? 0} />
          </div>

          {data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              <span>{data.coverage_note}</span>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} barSize={gran === "week" ? 16 : 26} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
              <YAxis yAxisId="vol" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false}
                     label={{ value: "Touchpoints", angle: -90, position: "insideLeft", style: { fontSize: 10, fill: "var(--color-ink-4)" } }} />
              <YAxis yAxisId="act" orientation="right" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false}
                     label={{ value: "Activated", angle: 90, position: "insideRight", style: { fontSize: 10, fill: "var(--color-ink-4)" } }} />
              <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {CHANNEL.map((c) => (
                <Bar key={c.key} yAxisId="vol" dataKey={c.key} name={c.label} stackId="vol" fill={c.color}
                     radius={c.key === "other" ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
              ))}
              {ACTIVATION.map((a) => (
                <Line key={a.key} yAxisId="act" type="monotone" dataKey={a.key} name={a.label}
                      stroke={a.color} strokeWidth={2} dot={{ r: 2 }} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-ink-4">
            Bars = activity volume (effort) by channel · lines = new contacts/accounts first-touched (activation).
            Team = Avni &amp; Damon (email, meetings, manual logs).
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function Stat({ label, value, sub, up }: { label: string; value: number; sub?: string; up?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className="text-[20px] font-semibold leading-tight text-ink">{value.toLocaleString()}</span>
      {sub ? <span className={`text-[11px] ${up ? "text-green" : "text-red"}`}>{sub}</span> : null}
    </div>
  );
}
