import { useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer,
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

/** Period label without tz drift: "2026-05-11" → "May 11" (week) / "May 26" (month). */
function fmtPeriod(iso: string, gran: "week" | "month"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  return gran === "week" ? `${month} ${d}` : `${month} ${String(y).slice(2)}`;
}

/**
 * Outreach & Activation over time — two clean single-axis panels (no dual axis):
 * top = activation (new contacts/accounts first-touched, the outcome),
 * bottom = activity volume by channel (the effort). Shared time axis.
 */
export function ActivityTrends() {
  const [gran, setGran] = useState<"week" | "month">("week");
  const { data, isLoading, isError, refetch } = useActivityTrends(gran);

  const chartData = useMemo(
    () => (data?.buckets ?? []).map((b: ActivityTrendBucket) => ({ ...b, label: fmtPeriod(b.period, gran) })),
    [data, gran],
  );

  const delta = useMemo(() => {
    const b = data?.buckets ?? [];
    if (b.length < 2) return null;
    return { d: b[b.length - 1].new_contacts - b[b.length - 2].new_contacts };
  }, [data]);

  const axis = { tick: { fontSize: 11 }, stroke: "var(--color-ink-3)" };
  const tip = { contentStyle: { fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" } };

  return (
    <SectionCard
      title="Outreach & Activation"
      storageScope="jobs"
      action={
        <div className="flex items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11.5px]">
          {(["week", "month"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGran(g)}
              className={`rounded px-2.5 py-1 font-medium ${gran === g ? "bg-ink text-surface" : "text-ink-3 hover:text-ink"}`}>
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
        <div className="flex flex-col gap-5 px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label={`Contacts activated · ${gran === "week" ? "12 wks" : "12 mos"}`} value={data?.totals.new_contacts ?? 0}
                  sub={delta ? `${delta.d >= 0 ? "+" : ""}${delta.d} vs prior ${gran}` : undefined} up={delta ? delta.d >= 0 : undefined} />
            <Stat label="Accounts activated" value={data?.totals.new_accounts ?? 0} />
            <Stat label="Total touchpoints" value={data?.totals.touchpoints ?? 0} />
          </div>

          {data?.coverage_note ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" /><span>{data.coverage_note}</span>
            </div>
          ) : null}

          {/* Panel 1 — Activation (outcome) */}
          <div>
            <PanelHead title="New contacts & accounts activated" hint="who first heard from us each period" />
            <ResponsiveContainer width="100%" height={170}>
              <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="label" {...axis} />
                <YAxis allowDecimals={false} {...axis} />
                <ReTooltip {...tip} />
                <Line type="monotone" dataKey="new_contacts" name="Contacts" stroke="#4242EA" strokeWidth={2.5} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="new_accounts" name="Accounts" stroke="#FF33FF" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
            <Legend items={[{ label: "Contacts", color: "#4242EA" }, { label: "Accounts", color: "#FF33FF" }]} />
          </div>

          {/* Panel 2 — Activity volume (effort) */}
          <div>
            <PanelHead title="Activity volume by channel" hint="total touchpoints — emails, meetings, calls" />
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={chartData} barSize={gran === "week" ? 16 : 26} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="label" {...axis} />
                <YAxis allowDecimals={false} {...axis} />
                <ReTooltip {...tip} />
                {CHANNEL.map((c) => (
                  <Bar key={c.key} dataKey={c.key} name={c.label} stackId="v" fill={c.color}
                       radius={c.key === "other" ? [3, 3, 0, 0] : undefined} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <Legend items={CHANNEL.map((c) => ({ label: c.label, color: c.color }))} />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function PanelHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="text-[12px] font-semibold text-ink">{title}</span>
      <span className="text-[11px] text-ink-4">· {hint}</span>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 pl-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: i.color }} />{i.label}
        </span>
      ))}
    </div>
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
