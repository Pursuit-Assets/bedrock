import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Inbox,
  NotebookPen,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { cn } from "@/lib/utils";
import {
  usePebbleAutomations,
  usePebbleSessions,
} from "@/services/pebbleSessions";
import { PebbleAskTab } from "./PebbleAskTab";
import { PebbleAutomationsTab } from "./PebbleAutomationsTab";
import { PebbleNotesTab } from "./PebbleNotesTab";
import { PebbleWorkTab } from "./PebbleWorkTab";

const PREFS_KEY = "bedrock:pebble:floating-box";
type TabId = "ask" | "work" | "automations" | "notes";

interface BoxPrefs {
  open: boolean;
  tab: TabId;
}

const DEFAULTS: BoxPrefs = { open: false, tab: "ask" };

const TABS: { id: TabId; label: string; icon: typeof Bot; description: string }[] = [
  { id: "ask", label: "Ask", icon: Bot, description: "Talk to Pebble" },
  { id: "work", label: "Work", icon: Wrench, description: "Active research flows" },
  { id: "automations", label: "Automations", icon: Inbox, description: "Pending review queue" },
  { id: "notes", label: "Notes", icon: NotebookPen, description: "Quick scratchpad" },
];

/**
 * Pebble floating toolbox.
 *
 * Always-available agent surface, mounted to `document.body` via a
 * portal so it floats above every layout (including a collapsed left
 * nav). Two states:
 *
 *   • Closed — a single 48px circular launcher pinned bottom-right.
 *     One tap / `\`` to open.
 *   • Open   — a 420×640 panel anchored bottom-right with four tabs:
 *     Ask, Work, Automations, Notes. Tab + open/closed state persist
 *     to localStorage (bedrock:pebble:floating-box).
 *
 * The Ask tab streams from /api/pebble/ask (PR #184). When the engine
 * isn't connected the tab falls back to an "engine offline" state and
 * the rest of the toolbox keeps working — Notes, in particular, is
 * fully self-contained (localStorage) so it always works.
 *
 * Portal target: a div appended to document.body on first mount. We
 * never tear it down (cheap, keeps the box stable across route
 * changes) — the React tree owns content, the DOM node is just a
 * mount point.
 */
export function PebbleFloatingBox() {
  const { prefs, setPrefs } = useLayoutPrefs<BoxPrefs>(PREFS_KEY, DEFAULTS);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  // Lazily create + memoize a portal mount node on document.body.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const existing = document.getElementById("pebble-portal");
    if (existing) {
      setPortalEl(existing);
      return;
    }
    const el = document.createElement("div");
    el.id = "pebble-portal";
    document.body.appendChild(el);
    setPortalEl(el);
  }, []);

  const open = useCallback(
    (tab?: TabId) => setPrefs({ open: true, ...(tab ? { tab } : {}) }),
    [setPrefs],
  );
  const close = useCallback(() => setPrefs({ open: false }), [setPrefs]);
  const toggle = useCallback(
    () => setPrefs({ open: !prefs.open }),
    [setPrefs, prefs.open],
  );

  // Keyboard: backtick (`) toggles. Skipped when typing into a field
  // so editors, the inbox filter, etc. don't get hijacked.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "`" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  // Escape closes (but only when nothing nested is focused that would
  // also want Escape — we keep it simple and just close).
  useEffect(() => {
    if (!prefs.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prefs.open, close]);

  if (!portalEl) return null;

  return createPortal(
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col items-end gap-2">
      {prefs.open ? (
        <Panel
          tab={prefs.tab}
          onTabChange={(t) => setPrefs({ tab: t })}
          onClose={close}
        />
      ) : null}
      <Launcher open={prefs.open} onClick={() => (prefs.open ? close() : open())} />
    </div>,
    portalEl,
  );
}

/** Wrapper that keeps a tab in the DOM (so its state and any in-flight
 *  effects survive) while hiding it from the user when inactive. */
function TabSlot({
  id,
  active,
  children,
}: {
  id: TabId;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      id={`pebble-tab-${id}`}
      role="tabpanel"
      hidden={!active}
      aria-hidden={!active}
      className={cn("absolute inset-0", active ? "flex flex-col" : "")}
    >
      {children}
    </div>
  );
}

function Launcher({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "Close Pebble" : "Open Pebble (`)"}
      aria-expanded={open}
      title={open ? "Close Pebble" : "Pebble — press ` to toggle"}
      className={cn(
        "group grid h-12 w-12 place-items-center rounded-full text-white shadow-lg transition-all",
        "bg-gradient-to-br from-accent to-accent-ink hover:scale-105 hover:shadow-xl",
        open && "rotate-45",
      )}
    >
      {open ? (
        <X size={20} className="transition-transform" />
      ) : (
        <Sparkles size={18} className="transition-transform group-hover:rotate-12" />
      )}
    </button>
  );
}

function Panel({
  tab,
  onTabChange,
  onClose,
}: {
  tab: TabId;
  onTabChange: (t: TabId) => void;
  onClose: () => void;
}) {
  const sessionsQ = usePebbleSessions();
  const automationsQ = usePebbleAutomations();
  const activeWork = (sessionsQ.data?.sessions ?? []).filter(
    (s) => s.status !== "done" && s.status !== "failed",
  ).length;
  const pendingAutomations = automationsQ.data?.automations.length ?? 0;
  const badgeFor = (id: TabId): number | null => {
    if (id === "work") return activeWork > 0 ? activeWork : null;
    if (id === "automations")
      return pendingAutomations > 0 ? pendingAutomations : null;
    return null;
  };

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label="Pebble"
      className="flex h-[640px] w-[420px] max-h-[calc(100vh-120px)] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl animate-in slide-in-from-bottom-2 duration-150"
    >
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border-strong bg-gradient-to-br from-accent-soft to-surface-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Sparkles size={14} className="text-accent" />
          Pebble
          <span className="rounded bg-surface px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider text-ink-3">
            beta
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink"
        >
          <X size={13} />
        </button>
      </header>

      <nav
        role="tablist"
        aria-label="Pebble sections"
        className="flex flex-shrink-0 border-b border-border-strong bg-surface-2"
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          const Icon = t.icon;
          const count = badgeFor(t.id);
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={`pebble-tab-${t.id}`}
              onClick={() => onTabChange(t.id)}
              title={t.description}
              className={cn(
                "group relative flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-[11.5px] font-medium transition-colors",
                active
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              <Icon size={12} />
              <span>{t.label}</span>
              {count != null ? (
                <span
                  aria-label={`${count} pending`}
                  className={cn(
                    "mono inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] font-semibold tabular-nums",
                    active
                      ? "bg-accent text-white"
                      : "bg-red text-white",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* All four tabs mount once and stay mounted. We toggle visibility
          via `hidden` instead of conditional render so per-tab state —
          including in-flight Ask streams and Notes drafts — survives
          a tab switch. The badge counts and query polling are owned by
          this Panel; tabs themselves are pure views over shared hooks. */}
      <div className="relative flex-1 overflow-hidden">
        <TabSlot id="ask" active={tab === "ask"}>
          <PebbleAskTab isActive={tab === "ask"} />
        </TabSlot>
        <TabSlot id="work" active={tab === "work"}>
          <PebbleWorkTab />
        </TabSlot>
        <TabSlot id="automations" active={tab === "automations"}>
          <PebbleAutomationsTab />
        </TabSlot>
        <TabSlot id="notes" active={tab === "notes"}>
          <PebbleNotesTab />
        </TabSlot>
      </div>
    </section>
  );
}
