import { type ReactNode, useCallback, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * Resizable two-pane split with edge-tab collapse.
 *
 * Either side can be dragged shut OR collapsed via the callback handed
 * to its `node` render function (so panes can render their own chevron
 * inside their header). When a side reaches 0%, the pane is hidden and
 * the matching `collapsedTab` strip appears on that edge. Clicking the
 * strip (or programmatically calling `collapse(false)`) restores it.
 *
 * Layout (split percentages) persists to localStorage under `storageKey`.
 *
 * Ported behavior of `frontend/src/pages/Priorities.tsx:176–457`
 * (`CalendarInboxSplit`), generalized as a reusable primitive.
 */
export interface SplitPaneApi {
  /** True when this pane is currently collapsed to its edge tab. */
  isCollapsed: boolean;
  /** Collapse the pane to its edge tab (drag-equivalent). */
  collapse: () => void;
  /** Restore the pane to its previous size. */
  expand: () => void;
  /** Toggle helper. */
  toggle: () => void;
}

export interface SplitPaneConfig {
  /** Pane content. May be a node or a render-fn taking the pane API
   *  (so the pane can wire its own collapse chevron). */
  node: ReactNode | ((api: SplitPaneApi) => ReactNode);
  /** Default size as a percentage (0–100). */
  defaultPct?: number;
  /** Minimum size as a percentage before snap-collapse. */
  minPct?: number;
  /** Vertical edge strip shown when the pane is collapsed. */
  collapsedTab: ReactNode;
}

export interface SplitPanelProps {
  /** localStorage key for split state. Namespace per surface, e.g. `"bedrock:home:jp:cal-inbox"`. */
  storageKey: string;
  left: SplitPaneConfig;
  right: SplitPaneConfig;
  /** CSS height (defaults to `calc(100vh - 240px)` with 400–800px clamp). */
  height?: string;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
}

export function SplitPanel({
  storageKey,
  left,
  right,
  height = "calc(100vh - 240px)",
  minHeight = 400,
  maxHeight = 800,
  className,
}: SplitPanelProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: storageKey,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    panelIds: ["left", "right"],
  });

  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const collapseLeft = useCallback(() => leftRef.current?.collapse(), [leftRef]);
  const expandLeft = useCallback(() => leftRef.current?.expand(), [leftRef]);
  const collapseRight = useCallback(() => rightRef.current?.collapse(), [rightRef]);
  const expandRight = useCallback(() => rightRef.current?.expand(), [rightRef]);

  const leftApi: SplitPaneApi = {
    isCollapsed: leftCollapsed,
    collapse: collapseLeft,
    expand: expandLeft,
    toggle: leftCollapsed ? expandLeft : collapseLeft,
  };
  const rightApi: SplitPaneApi = {
    isCollapsed: rightCollapsed,
    collapse: collapseRight,
    expand: expandRight,
    toggle: rightCollapsed ? expandRight : collapseRight,
  };

  const leftNode = typeof left.node === "function" ? left.node(leftApi) : left.node;
  const rightNode = typeof right.node === "function" ? right.node(rightApi) : right.node;

  return (
    <div
      className={cn("flex w-full gap-0", className)}
      style={{ height, minHeight, maxHeight }}
    >
      {leftCollapsed ? (
        <button
          type="button"
          onClick={expandLeft}
          aria-label="Expand left pane"
          className="group flex flex-shrink-0 select-none items-center rounded-l-md border border-r-0 border-border-strong bg-surface-2 px-1.5 py-3 text-[12px] font-semibold text-ink-2 transition-colors hover:bg-accent hover:text-white"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {left.collapsedTab}
        </button>
      ) : null}

      <Group
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        style={{ flex: 1, display: "flex" }}
      >
        <Panel
          id="left"
          panelRef={leftRef}
          defaultSize={left.defaultPct ?? 60}
          minSize={left.minPct ?? 30}
          collapsible
          collapsedSize={0}
          onResize={(size) => setLeftCollapsed(size.asPercentage === 0)}
        >
          {leftNode}
        </Panel>

        <Separator
          className="group relative shrink-0"
          style={{ width: 8, background: "transparent", cursor: "col-resize" }}
          aria-label="Resize panes"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-border-strong transition-colors group-hover:bg-accent"
          />
        </Separator>

        <Panel
          id="right"
          panelRef={rightRef}
          defaultSize={right.defaultPct ?? 40}
          minSize={right.minPct ?? 25}
          collapsible
          collapsedSize={0}
          onResize={(size) => setRightCollapsed(size.asPercentage === 0)}
        >
          {rightNode}
        </Panel>
      </Group>

      {rightCollapsed ? (
        <button
          type="button"
          onClick={expandRight}
          aria-label="Expand right pane"
          className="group flex flex-shrink-0 select-none items-center rounded-r-md border border-l-0 border-border-strong bg-surface-2 px-1.5 py-3 text-[12px] font-semibold text-ink-2 transition-colors hover:bg-accent hover:text-white"
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
        >
          {right.collapsedTab}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Imperative collapse handles exposed so consumers can render their own
 * in-pane collapse buttons (e.g., a chevron in the pane header).
 *
 * Pass these refs back into `SplitPanel` via `Panel.panelRef` when you
 * need the handle; otherwise the internal refs handle expand-on-tab-click.
 */
export { usePanelRef };
