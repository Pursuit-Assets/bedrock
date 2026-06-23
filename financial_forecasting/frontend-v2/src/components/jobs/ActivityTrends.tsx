import { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";

import { SectionCard } from "@/components/detail";
import { useActivityTrends, type ActivityTrendBucket, type OutreachChannel } from "@/services/jobs";

const NEW_COLOR = "#4242EA";       // new accounts (activation)
const EXISTING_COLOR = "#C7C7F5";  // existing accounts

function fmtPeriod(iso: string, gran: "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  return gran === "week" ? `${month} ${d}` : `${month} ${String(y).slice(2)}`;
}

/**
 * Account-level outreach over time — one stacked bar per period, split into
 * touches to NEW accounts (first activated that period) vs EXISTING accounts.
 * Toggle the channel (all / email / meeting) and the bucket size (week/month).
 */
export function ActivityTrends() {
  const [gran, setGran] = useState<"week" | "month">("week");
  const [channel, setChannel] = useState<OutreachChannel>("all");
  const { data, isLoading, isError, refetch } = useActivityTrends(gran, channel);

  const chartData = useMemo(
    () => (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({ ...b, label: fmtPeriod(b.period, gran) })),
    [data, gran],
  );

  return (
    <SectionCard
      title="Outreach & Activation"
      storageScope="jobs"
      action={
        <div className="flex items-center gap-2">
          <Toggle value={channel} onChange={(v) => setChannel(v as OutreachChannel)}
                  opts={[["all", "All"], ["email", "Email"], ["meeting", "Meetings"]]} />
          <Toggle value={gran} onChange={(v) => setGran(v as "week" | "month")}
                  opts={[["week", "Weekly"], ["month", "Monthly"]]} />
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2 px-5 py-10">
          <p className="text-[13px] text-red">Couldn't load outreach trends.</p>
          <button type="button" onClick={() => refetch()} className="rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label={`Accounts reached · ${gran === "week" ? "12 wks" : "12 mos"}`} value={data?.totals.touches ?? 0} />
            <Stat label="To new accounts" value={data?.totals.new ?? 0} accent />
            <Stat label="To existing accounts" value={data?.totals.existing ?? 0} />
          </div>

          {data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /><span>{data.coverage_note}</span>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} barSize={gran === "week" ? 18 : 30} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-3)" allowDecimals={false} />
              <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }} />
              <Bar dataKey="new" name="New accounts" stackId="a" fill={NEW_COLOR} />
              <Bar dataKey="existing" name="Existing accounts" stackId="a" fill={EXISTING_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap items-center gap-4 pl-1">
            <Legend color={NEW_COLOR} label="New accounts (first activated this period)" />
            <Legend color={EXISTING_COLOR} label="Existing accounts" />
          </div>
          <p className="text-[11px] text-ink-4">
            Account-level outreach by Avni &amp; Damon (email, meetings, manual logs), counted once per account per period.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function Toggle({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: [string, string][] }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11.5px]">
      {opts.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 font-medium ${value === v ? "bg-ink text-surface" : "text-ink-3 hover:text-ink"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />{label}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={`text-[20px] font-semibold leading-tight ${accent ? "text-accent" : "text-ink"}`}>{value.toLocaleString()}</span>
    </div>
  );
}
