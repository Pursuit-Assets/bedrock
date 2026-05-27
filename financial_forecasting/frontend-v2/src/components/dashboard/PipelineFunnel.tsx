import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

import { fmtMoney } from "@/lib/format";
import {
  ACTIVE_FUNNEL_STAGES,
  classifyTransition,
  getStageHexColor,
} from "@/lib/funnelStages";
import { cn } from "@/lib/utils";
import {
  useStageHistory,
  type FunnelStageChange,
} from "@/services/opportunities";
import type { SfOpportunity } from "@/types/salesforce";

// ── Lookback range ───────────────────────────────────────────────────────

const LOOKBACK_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
  { value: 60, label: "60d" },
  { value: 90, label: "90d" },
] as const;

type LookbackDays = (typeof LOOKBACK_OPTIONS)[number]["value"];

// ── Movement model ───────────────────────────────────────────────────────

interface StageMovement {
  opportunityId: string;
  opportunityName: string;
  amount: number;
  fromStage: string;
  toStage: string;
  changedDate: string;
}

interface FunnelLayer {
  stage: string;
  count: number;
  totalAmount: number;
  /** Forward moves into this stage from an earlier one. */
  advancedIn: StageMovement[];
  /** Forward moves out of this stage to a later one. */
  advancedOut: StageMovement[];
  /** Backward moves into this stage from a later one (regression in). */
  retreatedIn: StageMovement[];
  /** Backward moves out of this stage to an earlier one. */
  retreatedOut: StageMovement[];
  /** Wins recorded on the layer the opp was in before closing. */
  wonOut: StageMovement[];
  /** Losses recorded the same way as wins. */
  lostOut: StageMovement[];
  /** True when the stage has rows but zero movement in the lookback. */
  isStagnant: boolean;
}

/** Build the funnel layers from open opps + recent stage history. The
 *  movement model mirrors the deployed funnel one-for-one: dedupe on
 *  `OpportunityId:OldValue->NewValue`, classify each transition, and
 *  attribute it to both endpoints (or just the from-side for terminal
 *  transitions). */
function buildFunnelData(
  opps: SfOpportunity[],
  history: FunnelStageChange[],
): FunnelLayer[] {
  const stageMap = new Map<
    string,
    {
      count: number;
      total: number;
      advancedIn: StageMovement[];
      advancedOut: StageMovement[];
      retreatedIn: StageMovement[];
      retreatedOut: StageMovement[];
      wonOut: StageMovement[];
      lostOut: StageMovement[];
    }
  >();
  for (const stage of ACTIVE_FUNNEL_STAGES) {
    stageMap.set(stage, {
      count: 0,
      total: 0,
      advancedIn: [],
      advancedOut: [],
      retreatedIn: [],
      retreatedOut: [],
      wonOut: [],
      lostOut: [],
    });
  }

  for (const opp of opps) {
    const entry = stageMap.get(opp.StageName);
    if (entry) {
      entry.count += 1;
      entry.total += opp.Amount ?? 0;
    }
  }

  const seen = new Set<string>();
  for (const change of history) {
    if (!change.OldValue || !change.NewValue) continue;
    const key = `${change.OpportunityId}:${change.OldValue}->${change.NewValue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = classifyTransition(change.OldValue, change.NewValue);
    const movement: StageMovement = {
      opportunityId: change.OpportunityId,
      opportunityName: change.OpportunityName ?? "Unknown",
      amount: change.Amount ?? 0,
      fromStage: change.OldValue,
      toStage: change.NewValue,
      changedDate: change.CreatedDate,
    };
    const fromEntry = stageMap.get(change.OldValue);
    const toEntry = stageMap.get(change.NewValue);
    if (kind === "forward") {
      fromEntry?.advancedOut.push(movement);
      toEntry?.advancedIn.push(movement);
    } else if (kind === "backward") {
      fromEntry?.retreatedOut.push(movement);
      toEntry?.retreatedIn.push(movement);
    } else if (kind === "won") {
      fromEntry?.wonOut.push(movement);
    } else {
      fromEntry?.lostOut.push(movement);
    }
  }

  return ACTIVE_FUNNEL_STAGES.map((stage) => {
    const e = stageMap.get(stage)!;
    const totalActivity =
      e.advancedIn.length +
      e.advancedOut.length +
      e.retreatedIn.length +
      e.retreatedOut.length +
      e.wonOut.length +
      e.lostOut.length;
    return {
      stage,
      count: e.count,
      totalAmount: e.total,
      advancedIn: e.advancedIn,
      advancedOut: e.advancedOut,
      retreatedIn: e.retreatedIn,
      retreatedOut: e.retreatedOut,
      wonOut: e.wonOut,
      lostOut: e.lostOut,
      isStagnant: e.count > 0 && totalActivity === 0,
    };
  });
}

// ── Component ────────────────────────────────────────────────────────────

export function PipelineFunnel({ opps }: { opps: SfOpportunity[] }) {
  const [days, setDays] = useState<LookbackDays>(30);
  const [focusOwnerId, setFocusOwnerId] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: historyData = [], isLoading: historyLoading } =
    useStageHistory(days);

  // Owner dropdown options come from the loaded opps.
  const availableOwners = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of opps) {
      if (o.OwnerId && !seen.has(o.OwnerId)) {
        seen.set(o.OwnerId, o.Owner?.Name ?? o.OwnerId);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [opps]);

  // If the focused owner falls out of the list (e.g., page-level filter
  // changed underneath us), reset focus to "all" so the funnel doesn't
  // appear empty.
  useEffect(() => {
    if (
      focusOwnerId !== "all" &&
      !availableOwners.some((o) => o.id === focusOwnerId)
    ) {
      setFocusOwnerId("all");
    }
  }, [availableOwners, focusOwnerId]);

  const effectiveOwnerIds = useMemo<Set<string> | null>(
    () => (focusOwnerId === "all" ? null : new Set([focusOwnerId])),
    [focusOwnerId],
  );

  const filteredOpps = useMemo(
    () =>
      opps.filter(
        (o) =>
          ACTIVE_FUNNEL_STAGES.includes(
            o.StageName as (typeof ACTIVE_FUNNEL_STAGES)[number],
          ) &&
          (!effectiveOwnerIds ||
            (!!o.OwnerId && effectiveOwnerIds.has(o.OwnerId))),
      ),
    [opps, effectiveOwnerIds],
  );

  const filteredHistory = useMemo(() => {
    if (!effectiveOwnerIds) return historyData;
    return historyData.filter(
      (h) => h.OwnerId && effectiveOwnerIds.has(h.OwnerId),
    );
  }, [historyData, effectiveOwnerIds]);

  const funnel = useMemo(
    () => buildFunnelData(filteredOpps, filteredHistory),
    [filteredOpps, filteredHistory],
  );

  const maxCount = Math.max(...funnel.map((l) => l.count), 1);
  const rangeLabel = `last ${days}d`;

  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong bg-surface-2 px-5 py-2">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            Pipeline Flow
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            Open opportunities by stage · stage transitions in the {rangeLabel}
            {historyLoading ? " · loading…" : ""}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {availableOwners.length >= 2 ? (
            <select
              value={focusOwnerId}
              onChange={(e) => setFocusOwnerId(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2"
            >
              <option value="all">Focus: All ({availableOwners.length})</option>
              {availableOwners.map((o) => (
                <option key={o.id} value={o.id}>
                  Focus: {o.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="inline-flex overflow-hidden rounded border border-border-strong bg-surface">
            {LOOKBACK_OPTIONS.map((opt, i) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDays(opt.value)}
                className={cn(
                  "h-7 px-2 text-[11.5px] font-medium text-ink-2 transition-colors",
                  i > 0 && "border-l border-border-strong",
                  days === opt.value && "bg-surface-2 text-ink",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        {funnel.map((layer) => {
          const isExpanded = expanded === layer.stage;
          // Pure proportional width — the deployed funnel had a 20%
          // floor here that made stages with very different counts
          // look the same size whenever any single stage was much
          // larger than the rest. The 80px minWidth below keeps tiny
          // bars legible without flattening volume signal.
          const widthPct = (layer.count / maxCount) * 100;
          const progressingCount =
            layer.advancedIn.length + layer.advancedOut.length;
          const setbackCount =
            layer.retreatedIn.length + layer.retreatedOut.length;
          const wonCount = layer.wonOut.length;
          const lostCount = layer.lostOut.length;
          const hasActivity =
            progressingCount + setbackCount + wonCount + lostCount > 0;
          const net = progressingCount + wonCount - setbackCount - lostCount;
          const color = getStageHexColor(layer.stage);

          return (
            <div key={layer.stage}>
              <button
                type="button"
                onClick={() =>
                  setExpanded(isExpanded ? null : layer.stage)
                }
                className="flex w-full items-center gap-3 border-t border-border-strong px-4 py-2 text-left transition-colors hover:bg-surface-2/40 first:border-t-0"
              >
                <span className="flex-shrink-0 text-ink-4">
                  {isExpanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </span>

                {/* Stage label lives in its own fixed column so the bar
                    can be a pure proportional indicator (no minWidth
                    flooring small stages to the same visible size). */}
                <span
                  className="w-[180px] flex-shrink-0 truncate text-[12.5px] font-semibold text-ink"
                  title={layer.stage}
                >
                  {layer.stage}
                </span>

                <div
                  className="h-2.5 flex-shrink-0 overflow-hidden rounded-full bg-surface-2"
                  style={{ width: "30%" }}
                  title={`${layer.count} opps · ${Math.round(widthPct)}% of largest stage`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: color,
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>

                <div className="flex flex-1 items-center justify-end gap-2 text-[11.5px]">
                  <span
                    className="text-ink-3"
                    title={`${layer.count} opportunities currently in ${layer.stage}`}
                  >
                    {layer.count} opps
                  </span>
                  <span
                    className="mono font-bold tabular-nums text-ink"
                    title={`Sum of Amount for all ${layer.count} opps in ${layer.stage}`}
                  >
                    {fmtMoney(layer.totalAmount)}
                  </span>

                  <span className="ml-1 inline-flex items-center gap-1.5 border-l border-border-strong pl-2">
                    {progressingCount > 0 ? (
                      <span
                        className="font-semibold text-green-700"
                        title={`${progressingCount} opps advanced forward or entered from an earlier stage in the ${rangeLabel}`}
                      >
                        {progressingCount} progressing
                      </span>
                    ) : null}
                    {wonCount > 0 ? (
                      <>
                        {progressingCount > 0 ? (
                          <span className="text-ink-4">·</span>
                        ) : null}
                        <span
                          className="font-bold text-green"
                          title={`${wonCount} opp${wonCount !== 1 ? "s" : ""} closed as Won from ${layer.stage} in the ${rangeLabel}`}
                        >
                          {wonCount} won
                        </span>
                      </>
                    ) : null}
                    {setbackCount > 0 ? (
                      <>
                        {progressingCount > 0 || wonCount > 0 ? (
                          <span className="text-ink-4">·</span>
                        ) : null}
                        <span
                          className="font-semibold text-red"
                          title={`${setbackCount} opps regressed backward or fell back to an earlier stage in the ${rangeLabel}`}
                        >
                          {setbackCount} setback{setbackCount !== 1 ? "s" : ""}
                        </span>
                      </>
                    ) : null}
                    {lostCount > 0 ? (
                      <>
                        {progressingCount > 0 ||
                        wonCount > 0 ||
                        setbackCount > 0 ? (
                          <span className="text-ink-4">·</span>
                        ) : null}
                        <span
                          className="font-semibold text-ink-3"
                          title={`${lostCount} opp${lostCount !== 1 ? "s" : ""} closed as Lost or Withdrawn from ${layer.stage} in the ${rangeLabel}`}
                        >
                          {lostCount} lost
                        </span>
                      </>
                    ) : null}
                    {hasActivity ? (
                      <span
                        title={`Net = (${progressingCount} progressing + ${wonCount} won) − (${setbackCount} setback${setbackCount !== 1 ? "s" : ""} + ${lostCount} lost)`}
                        className={cn(
                          "ml-1 inline-flex min-w-[24px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold",
                          net > 0 && "bg-green-soft text-green",
                          net < 0 && "bg-red-soft text-red",
                          net === 0 && "bg-surface-2 text-ink-3",
                        )}
                      >
                        {net > 0 ? `+${net}` : net}
                      </span>
                    ) : null}
                    {layer.isStagnant ? (
                      <span
                        title={`${layer.count} opp${layer.count !== 1 ? "s" : ""} stuck — no stage activity in the ${rangeLabel}`}
                        className="text-amber-600"
                      >
                        <AlertTriangle size={12} />
                      </span>
                    ) : null}
                  </span>
                </div>
              </button>

              {isExpanded ? (
                <StageFlowDetail
                  layer={layer}
                  oppsInStage={filteredOpps.filter(
                    (o) => o.StageName === layer.stage,
                  )}
                  rangeLabel={rangeLabel}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Per-stage expand ─────────────────────────────────────────────────────

interface FlowRow {
  opportunityId: string;
  opportunityName: string;
  amount: number;
  label: string;
  stage: string;
  changedDate: string;
}

function buildProgressingRows(layer: FunnelLayer): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const m of layer.advancedOut) {
    rows.push({
      opportunityId: m.opportunityId,
      opportunityName: m.opportunityName,
      amount: m.amount,
      label: "Advanced to",
      stage: m.toStage,
      changedDate: m.changedDate,
    });
  }
  for (const m of layer.advancedIn) {
    rows.push({
      opportunityId: m.opportunityId,
      opportunityName: m.opportunityName,
      amount: m.amount,
      label: "Entered from",
      stage: m.fromStage,
      changedDate: m.changedDate,
    });
  }
  return rows;
}

function buildSetbackRows(layer: FunnelLayer): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const m of layer.retreatedIn) {
    rows.push({
      opportunityId: m.opportunityId,
      opportunityName: m.opportunityName,
      amount: m.amount,
      label: "Returned from",
      stage: m.fromStage,
      changedDate: m.changedDate,
    });
  }
  for (const m of layer.retreatedOut) {
    rows.push({
      opportunityId: m.opportunityId,
      opportunityName: m.opportunityName,
      amount: m.amount,
      label: "Fell back to",
      stage: m.toStage,
      changedDate: m.changedDate,
    });
  }
  return rows;
}

function buildWinRows(layer: FunnelLayer): FlowRow[] {
  return layer.wonOut.map((m) => ({
    opportunityId: m.opportunityId,
    opportunityName: m.opportunityName,
    amount: m.amount,
    label: "Closed to",
    stage: m.toStage,
    changedDate: m.changedDate,
  }));
}

function buildLossRows(layer: FunnelLayer): FlowRow[] {
  return layer.lostOut.map((m) => ({
    opportunityId: m.opportunityId,
    opportunityName: m.opportunityName,
    amount: m.amount,
    label: "Lost to",
    stage: m.toStage,
    changedDate: m.changedDate,
  }));
}

function StageFlowDetail({
  layer,
  oppsInStage,
  rangeLabel,
}: {
  layer: FunnelLayer;
  // oppsInStage was used to render an "In this stage" inventory
  // table; kept on the prop so callers don't need to change, but no
  // longer rendered — the four movement tables (progressing / wins /
  // setbacks / losses) are what's actionable on the dashboard.
  oppsInStage: SfOpportunity[];
  rangeLabel: string;
}) {
  void oppsInStage;
  const progressing = buildProgressingRows(layer);
  const setbacks = buildSetbackRows(layer);
  const wins = buildWinRows(layer);
  const losses = buildLossRows(layer);

  return (
    <div className="border-t border-border-strong bg-surface-2/30 px-5 py-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <FlowTable
          title={`Progressing (${progressing.length}) · ${rangeLabel}`}
          rows={progressing}
          accent="green"
        />
        <FlowTable
          title={`Wins (${wins.length}) · ${rangeLabel}`}
          rows={wins}
          accent="green"
        />
        <FlowTable
          title={`Setbacks (${setbacks.length}) · ${rangeLabel}`}
          rows={setbacks}
          accent="red"
        />
        <FlowTable
          title={`Losses (${losses.length}) · ${rangeLabel}`}
          rows={losses}
          accent="ink"
        />
      </div>
    </div>
  );
}

function relativeDays(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function FlowTable({
  title,
  rows,
  accent,
}: {
  title: string;
  rows: FlowRow[];
  accent: "green" | "red" | "ink";
}) {
  const accentClass =
    accent === "green"
      ? "text-green"
      : accent === "red"
        ? "text-red"
        : "text-ink-3";

  return (
    <div className="overflow-hidden rounded border border-border-strong bg-surface">
      <div
        className={cn(
          "border-b border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider",
          accentClass,
        )}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-ink-3">No movement.</div>
      ) : (
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.opportunityId}-${i}`} className="border-t border-border-strong first:border-t-0">
                <td className="px-3 py-1.5">
                  <Link
                    to={`/opportunities/${r.opportunityId}`}
                    className="block truncate font-medium text-ink hover:underline"
                    title={r.opportunityName}
                  >
                    {r.opportunityName}
                  </Link>
                  <span className="block truncate text-[10.5px] text-ink-3">
                    {r.label} {r.stage}
                  </span>
                </td>
                <td className="mono w-[100px] px-3 py-1.5 text-right tabular-nums">
                  {r.amount > 0 ? fmtMoney(r.amount) : "—"}
                </td>
                <td className="mono w-[80px] px-3 py-1.5 text-right text-[11px] tabular-nums text-ink-3">
                  {relativeDays(r.changedDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
