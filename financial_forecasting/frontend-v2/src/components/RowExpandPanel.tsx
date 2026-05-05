import { useState } from "react";

import { cn } from "@/lib/utils";

export const ROW_EXPAND_HEIGHT = 320;

export interface ExpandTab {
  id: string;
  label: string;
  /** Optional count badge — rendered as " · 12" after the label. */
  count?: number | null;
  /** Lazy render — only invoked when this tab is active so hidden
   *  tabs don't fire their queries. */
  render: () => React.ReactNode;
}

/**
 * Tabbed row-expand shell. Drops in below an expanded table row.
 * Fixed height so the virtualizer can pre-allocate space; only the
 * active tab is mounted so React Query queries on hidden tabs stay
 * inert until the user actually clicks them.
 */
export function RowExpandPanel({
  tabs,
  defaultTab,
  height = ROW_EXPAND_HEIGHT,
}: {
  tabs: ExpandTab[];
  defaultTab?: string;
  height?: number;
}) {
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div
      className="border-t border-border-strong bg-surface-2/40"
      style={{ height }}
    >
      <div
        role="tablist"
        className="flex items-center gap-1 border-b border-border-strong bg-surface px-4 pt-2"
      >
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <TabButton
              key={t.id}
              active={isActive}
              tabPanelId={`row-expand-panel-${t.id}`}
              onClick={() => setActive(t.id)}
            >
              {t.label}
              {typeof t.count === "number" && t.count > 0 ? ` · ${t.count}` : ""}
            </TabButton>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={current ? `row-expand-panel-${current.id}` : undefined}
        className="h-[calc(100%-32px)] overflow-y-auto"
      >
        {current ? current.render() : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  tabPanelId,
  onClick,
  children,
}: {
  active: boolean;
  tabPanelId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={tabPanelId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        "border-b-2 px-3 pb-1.5 pt-1 text-[12px] font-medium transition-colors",
        active
          ? "border-accent text-ink"
          : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}
