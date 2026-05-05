import { useEffect, useState } from "react";

/**
 * Tiny hook for sections that should remember whether they're expanded
 * across reloads. Persists to localStorage under the given key, so the
 * same key in different parts of the app shares state intentionally
 * (e.g. "Activity timeline" stays collapsed everywhere if the user
 * collapses it once).
 *
 * `defaultOpen` is the value used when storage is empty (i.e. the user
 * has never explicitly toggled). Pass a *current* boolean (e.g.
 * `tasks.some(open)`) to drive a smart default — when it changes
 * (data loads in, an item flips state), the effect re-syncs as long
 * as the user hasn't expressed a preference yet. Once they have, the
 * stored value wins forever.
 */
export function useCollapsible(storageKey: string, defaultOpen = true) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === "open") return true;
      if (stored === "closed") return false;
    } catch {}
    return defaultOpen;
  });

  // If the parent's smart default changes (e.g. tasks loaded, now
  // openCount > 0), and the user hasn't expressed a preference yet,
  // follow the new default.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) setOpen(defaultOpen);
    } catch {}
  }, [storageKey, defaultOpen]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "open" : "closed");
      } catch {}
      return next;
    });
  };
  return { open, toggle };
}
