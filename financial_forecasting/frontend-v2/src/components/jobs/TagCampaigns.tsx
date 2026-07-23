/**
 * Tag Campaigns — Performance section to prioritize outreach by tag.
 * Lists every tag as a campaign (alumni cohorts merged into "Fellow Alumni")
 * with contact + account counts; drag to reorder priority. The saved order
 * (catalog.sort_order) drives the "Priority" sort on the Contacts page.
 */
import { useEffect, useState } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2 } from "lucide-react";

import { useTagCampaigns, useSetTagCampaignOrder, type TagCampaign } from "@/services/jobs";
import { cn } from "@/lib/utils";

function Row({ c, rank }: { c: TagCampaign; rank: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.key });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 border-b border-border-strong bg-surface px-3 py-2 text-[12.5px] last:border-b-0",
        isDragging && "relative z-10 rounded shadow-lg ring-1 ring-accent",
      )}
    >
      <button type="button" {...attributes} {...listeners} className="cursor-grab touch-none text-ink-4 hover:text-ink-2 active:cursor-grabbing" aria-label={`Reorder ${c.label}`}>
        <GripVertical size={14} />
      </button>
      <span className="w-6 text-right font-mono text-[11px] text-ink-4">{rank}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{c.label}</span>
      <span className="w-24 text-right tabular-nums text-ink-2">{c.contacts.toLocaleString()}</span>
      <span className="w-24 text-right tabular-nums text-ink-2">{c.in_pipeline.toLocaleString()}</span>
      <span className="w-24 text-right tabular-nums text-ink-2">{c.accounts.toLocaleString()}</span>
    </div>
  );
}

export function TagCampaigns() {
  const { data, isLoading } = useTagCampaigns();
  const save = useSetTagCampaignOrder();
  const [items, setItems] = useState<TagCampaign[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Keep local order in sync with the server, but don't clobber an in-flight save.
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
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Campaigns · outreach priority</span>
        {save.isPending && <Loader2 size={12} className="animate-spin text-ink-4" />}
        <span className="text-[11px] text-ink-4">drag to reorder — top = highest priority; drives the Priority sort on Contacts</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-strong">
        <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          <span className="w-[14px]" /><span className="w-6 text-right">#</span>
          <span className="min-w-0 flex-1">Campaign (tag)</span>
          <span className="w-24 text-right">Contacts</span>
          <span className="w-24 text-right">In pipeline</span>
          <span className="w-24 text-right">Accounts</span>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-ink-3"><Loader2 size={14} className="animate-spin" /> Loading campaigns…</div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
              {items.map((c, idx) => <Row key={c.key} c={c} rank={idx + 1} />)}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
