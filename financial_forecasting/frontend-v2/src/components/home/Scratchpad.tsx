import { useEffect, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";

import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { cn } from "@/lib/utils";

interface ScratchpadPrefs {
  notes: string;
}

const STORAGE_KEY = "bedrock:home:jp:scratchpad";
const DEFAULTS: ScratchpadPrefs = { notes: "" };
const DEBOUNCE_MS = 400;

/**
 * Personal scratchpad — lives on the home page, persists to localStorage.
 *
 * Saves debounced (400ms after last keystroke) so we don't thrash
 * localStorage on every character. A small "Saved · just now" indicator
 * confirms persistence; if you wipe localStorage in DevTools, the
 * indicator stays accurate.
 */
export function Scratchpad({ className }: { className?: string }) {
  const { prefs, setPrefs } = useLayoutPrefs<ScratchpadPrefs>(STORAGE_KEY, DEFAULTS);
  const [draft, setDraft] = useState(prefs.notes);
  const [savedAt, setSavedAt] = useState<number | null>(prefs.notes ? Date.now() : null);
  const timerRef = useRef<number | null>(null);

  // Pick up updates from another tab.
  useEffect(() => {
    if (prefs.notes !== draft && document.activeElement?.tagName !== "TEXTAREA") {
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
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border-strong bg-surface p-4",
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          <NotebookPen size={13} className="text-accent" />
          Scratchpad
        </h2>
        <SavedIndicator savedAt={savedAt} />
      </header>
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Quick notes — saved to this browser only…"
        aria-label="Scratchpad notes"
        className="min-h-[140px] resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </section>
  );
}

function SavedIndicator({ savedAt }: { savedAt: number | null }) {
  const [, setTick] = useState(0);
  // Cheap re-render-every-30s to keep the relative label fresh.
  useEffect(() => {
    if (savedAt == null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [savedAt]);

  if (savedAt == null) {
    return <span className="text-[10.5px] text-ink-4">—</span>;
  }
  const diffSec = Math.floor((Date.now() - savedAt) / 1000);
  let label = "just now";
  if (diffSec >= 60) {
    const mins = Math.floor(diffSec / 60);
    label = mins === 1 ? "1 min ago" : `${mins} min ago`;
  }
  return (
    <span className="text-[10.5px] text-ink-3">Saved · {label}</span>
  );
}
