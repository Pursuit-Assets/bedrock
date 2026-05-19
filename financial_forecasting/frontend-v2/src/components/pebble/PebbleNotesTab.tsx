import { useEffect, useRef, useState } from "react";
import { Building2, FileText, NotebookPen } from "lucide-react";
import { useLocation } from "react-router-dom";

import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { cn } from "@/lib/utils";

interface ScratchpadPrefs {
  notes: string;
}

const STORAGE_KEY = "bedrock:home:jp:scratchpad";
const DEFAULTS: ScratchpadPrefs = { notes: "" };
const DEBOUNCE_MS = 400;

/**
 * Pebble Notes tab — the future home of the scratchpad.
 *
 * Same data source as the home-page Scratchpad (bedrock:home:jp:scratchpad
 * localStorage key) so a note typed here appears on the home page and
 * vice-versa. When the Segundo migration lands, both surfaces swap to
 * the server-backed hook at once.
 *
 * Includes a "context strip" hinting at what entity the note would link
 * to once the link table exists. Right now the strip just shows the
 * current route; future versions resolve the route to the open
 * account/opportunity/activity and capture that in the note record.
 */
export function PebbleNotesTab() {
  const { prefs, setPrefs } = useLayoutPrefs<ScratchpadPrefs>(STORAGE_KEY, DEFAULTS);
  const [draft, setDraft] = useState(prefs.notes);
  const [savedAt, setSavedAt] = useState<number | null>(
    prefs.notes ? Date.now() : null,
  );
  const timerRef = useRef<number | null>(null);
  const location = useLocation();

  // Pull in cross-tab updates when the user isn't actively editing.
  useEffect(() => {
    if (
      prefs.notes !== draft &&
      document.activeElement?.tagName !== "TEXTAREA"
    ) {
      setDraft(prefs.notes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.notes]);

  const onChange = (value: string) => {
    setDraft(value);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setPrefs({ notes: value });
      setSavedAt(Date.now());
    }, DEBOUNCE_MS);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border-strong bg-surface-2 px-3 py-2 text-[11px]">
        <ContextChip path={location.pathname} />
        <SavedIndicator savedAt={savedAt} />
      </div>
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Quick notes — saved to this browser. Pebble will link to the page you're on once the Segundo migration lands."
        aria-label="Notes"
        className="flex-1 resize-none rounded-none border-0 bg-surface px-3 py-3 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-4 focus:outline-none"
      />
      <footer className="flex-shrink-0 border-t border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] text-ink-3">
        <span className="inline-flex items-center gap-1">
          <NotebookPen size={10} /> Same notes as the home-page scratchpad ·
          local-only for now
        </span>
      </footer>
    </div>
  );
}

function ContextChip({ path }: { path: string }) {
  const ctx = inferContext(path);
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 text-ink-3"
      title="Pebble will tag this note with the page you're on when the Segundo link table lands."
    >
      {ctx.icon}
      <span className="text-ink-2">{ctx.label}</span>
    </span>
  );
}

function inferContext(path: string): { icon: React.ReactNode; label: string } {
  // Light heuristic. Real link-capture will resolve route params to
  // actual entity ids from the route table.
  if (path.startsWith("/accounts/")) {
    return { icon: <Building2 size={10} />, label: "Account in view" };
  }
  if (path.startsWith("/opportunities/")) {
    return { icon: <FileText size={10} />, label: "Opportunity in view" };
  }
  if (path.startsWith("/home/")) {
    return { icon: <NotebookPen size={10} />, label: "Home" };
  }
  return { icon: <NotebookPen size={10} />, label: path || "/" };
}

function SavedIndicator({ savedAt }: { savedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (savedAt == null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [savedAt]);
  if (savedAt == null) {
    return <span className={cn("text-ink-4")}>—</span>;
  }
  const diffSec = Math.floor((Date.now() - savedAt) / 1000);
  let label = "just now";
  if (diffSec >= 60) {
    const mins = Math.floor(diffSec / 60);
    label = mins === 1 ? "1 min ago" : `${mins} min ago`;
  }
  return <span>Saved · {label}</span>;
}
