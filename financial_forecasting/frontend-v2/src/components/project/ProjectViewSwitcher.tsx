import { useEffect, useState } from "react";
import { KanbanSquare, List, GanttChart } from "lucide-react";

import { cn } from "@/lib/utils";

export type ProjectView = "list" | "board" | "timeline";

const STORAGE_KEY = "bedrock:projects:view";

/** localStorage-backed last-used view; falls back to "list" on first visit. */
export function useProjectView(): [ProjectView, (v: ProjectView) => void] {
  const [view, setViewInner] = useState<ProjectView>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "list" || stored === "board" || stored === "timeline") return stored;
    } catch {}
    return "list";
  });

  // Sync across tabs — if another tab changes the view, follow along.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      if (e.newValue === "list" || e.newValue === "board" || e.newValue === "timeline") {
        setViewInner(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setView = (v: ProjectView) => {
    setViewInner(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {}
  };

  return [view, setView];
}

interface ProjectViewSwitcherProps {
  value: ProjectView;
  onChange: (v: ProjectView) => void;
  className?: string;
}

const OPTIONS: { value: ProjectView; label: string; Icon: typeof List }[] = [
  { value: "list", label: "List", Icon: List },
  { value: "board", label: "Board", Icon: KanbanSquare },
  { value: "timeline", label: "Timeline", Icon: GanttChart },
];

export function ProjectViewSwitcher({ value, onChange, className }: ProjectViewSwitcherProps) {
  return (
    <div
      role="tablist"
      aria-label="Project view"
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-border-strong bg-surface",
        className,
      )}
    >
      {OPTIONS.map(({ value: v, label, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            className={cn(
              "flex items-center gap-1.5 border-l border-border-strong px-3 py-1.5 text-[12px] font-medium first:border-l-0",
              active
                ? "bg-ink text-surface"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
