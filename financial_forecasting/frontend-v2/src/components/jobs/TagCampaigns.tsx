/**
 * Tag Campaigns — Performance section to prioritize outreach by tag.
 * Lists every tag as a campaign (alumni cohorts merged into "Fellow Alumni")
 * with a funnel bar (untouched → assigned → contacted → converted), contact/
 * account counts, and a staff owner. Drag to reorder priority; the saved order
 * (catalog.sort_order) drives the "Priority" sort on the Contacts page.
 */
import { useEffect, useState } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2 } from "lucide-react";

import { useTagCampaigns, useSetTagCampaignOrder, useSetCampaignOwner, useStaff, type TagCampaign } from "@/services/jobs";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";

// Legend for the stage funnel (bar 2).
const STAGE_LEGEND = [
  { label: "Assigned",  cls: "bg-amber-400" },
  { label: "Contacted", cls: "bg-accent" },
  { label: "Converted", cls: "bg-green-500" },
];
function Bar({ parts, denom, height = "h-2.5" }: { parts: { label: string; cls: string; n: number }[]; denom: number; height?: string }) {
  const d = denom || 1;
  return (
    <div className={cn("flex w-full overflow-hidden rounded-full bg-surface-2", height)} title={parts.map((p) => `${p.label}: ${p.n.toLocaleString()}`).join("  ·  ")}>
      {parts.map((p) => p.n > 0 && <div key={p.label} className={cn("h-full", p.cls)} style={{ width: `${(100 * p.n) / d}%` }} />)}
    </div>
  );
}
// Bar 1: pipeline coverage (in pipeline vs not). Bar 2: stage funnel among the in-pipeline set.
function FunnelBars({ f, total }: { f: TagCampaign["funnel"]; total: number }) {
  const inPipeline = Math.max(0, total - f.untouched);
  return (
    <div className="flex w-full flex-col gap-1">
      <Bar denom={total} parts={[
        { label: "In pipeline", cls: "bg-accent", n: inPipeline },
        { label: "Not in pipeline", cls: "bg-stone-200", n: f.untouched },
      ]} />
      <Bar denom={inPipeline} parts={[
        { label: "Assigned", cls: "bg-amber-400", n: f.assigned },
        { label: "Contacted", cls: "bg-accent", n: Math.max(0, f.contacted - f.converted) },
        { label: "Converted", cls: "bg-green-500", n: f.converted },
      ]} />
    </div>
  );
}

function Row({ c, rank, staffOptions }: { c: TagCampaign; rank: number; staffOptions: { value: string; label: string }[] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.key });
  const setOwner = useSetCampaignOwner();
  const staffName = (email: string | null) => staffOptions.find((s) => s.value === email)?.label ?? email ?? "—";
  const contacted = Math.max(0, c.funnel.contacted); // initial_outreach+converted+on_hold
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-3 border-b border-border-strong bg-surface px-3 py-2 text-[12.5px] last:border-b-0",
        isDragging && "relative z-10 rounded shadow-lg ring-1 ring-accent")}
    >
      <button type="button" {...attributes} {...listeners} className="cursor-grab touch-none text-ink-4 hover:text-ink-2 active:cursor-grabbing" aria-label={`Reorder ${c.label}`}><GripVertical size={14} /></button>
      <span className="w-5 text-right font-mono text-[11px] text-ink-4">{rank}</span>
      <span className="w-40 shrink-0 truncate font-medium text-ink" title={c.label}>{c.label}</span>
      {/* funnel — two bars: pipeline coverage, then stage funnel */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <FunnelBars f={c.funnel} total={c.contacts} />
        <span className="flex w-24 shrink-0 flex-col text-right tabular-nums text-[10.5px] leading-tight text-ink-3">
          <span title="in pipeline / total tagged">{c.in_pipeline.toLocaleString()}/{c.contacts.toLocaleString()} in pipe</span>
          <span title="contacted (outreach or further)">{contacted.toLocaleString()} contacted</span>
        </span>
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums text-ink-2" title="accounts">{c.accounts.toLocaleString()} <span className="text-ink-4">acct</span></span>
      {/* owner */}
      <span className="w-36 shrink-0" onClick={(e) => e.stopPropagation()}>
        <InlineSelect<string>
          value={c.owner_email ?? ""}
          options={staffOptions}
          emptyLabel="Set owner"
          renderValue={(v) => { const e = (v || c.owner_email) || null; return <span className={cn("truncate text-[12px]", e ? "text-ink-2" : "text-ink-4")}>{e ? staffName(e) : "Set owner"}</span>; }}
          onSave={(v) => new Promise<void>((res, rej) => setOwner.mutate({ key: c.key, owner_email: v || null }, { onSuccess: () => res(), onError: rej }))}
        />
      </span>
    </div>
  );
}

export function TagCampaigns() {
  const { data, isLoading } = useTagCampaigns();
  const { data: staff = [] } = useStaff();
  const save = useSetTagCampaignOrder();
  const [items, setItems] = useState<TagCampaign[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const staffOptions = [{ value: "", label: "— none —" }, ...staff.map((s) => ({ value: s.email, label: s.name }))];

  useEffect(() => { if (data && !save.isPending) setItems(data); }, [data, save.isPending]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.key === active.id);
    const to = items.findIndex((i) => i.key === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    save.mutate(next.map((i) => i.key));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Campaigns · outreach priority</span>
        {save.isPending && <Loader2 size={12} className="animate-spin text-ink-4" />}
        <span className="text-[11px] text-ink-4">drag to reorder · top bar = pipeline coverage · bottom bar = stage</span>
        {/* legend (stage funnel) */}
        <span className="ml-auto flex items-center gap-3 text-[10.5px] text-ink-4">
          {STAGE_LEGEND.map((s) => <span key={s.label} className="flex items-center gap-1"><span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.cls)} />{s.label}</span>)}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-strong">
        <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          <span className="w-[14px]" /><span className="w-5 text-right">#</span>
          <span className="w-40 shrink-0">Campaign</span>
          <span className="min-w-0 flex-1">Pipeline coverage &amp; stage funnel</span>
          <span className="w-20 shrink-0 text-right">Accounts</span>
          <span className="w-36 shrink-0">Owner</span>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-ink-3"><Loader2 size={14} className="animate-spin" /> Loading campaigns…</div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
              {items.map((c, idx) => <Row key={c.key} c={c} rank={idx + 1} staffOptions={staffOptions} />)}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
