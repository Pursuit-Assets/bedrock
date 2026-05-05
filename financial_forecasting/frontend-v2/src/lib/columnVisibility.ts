import { useState } from "react";

export function useColumnVisibility<K extends string>(
  storageKey: string,
  allColumns: K[],
  defaultVisible?: K[],
) {
  const [visible, setVisible] = useState<K[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as K[];
        const valid = parsed.filter((k) => allColumns.includes(k));
        if (valid.length > 0) return valid;
      }
    } catch {}
    return defaultVisible ? [...defaultVisible] : [...allColumns];
  });

  const toggle = (col: K) => {
    setVisible((prev) => {
      const next = prev.includes(col)
        ? prev.filter((k) => k !== col)
        : [...prev, col].sort((a, b) => allColumns.indexOf(a) - allColumns.indexOf(b));
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  /** Replace the visible list wholesale — used by saved views.
   *  Filters out unknown keys so a stale view won't poison the table. */
  const replaceAll = (next: K[]) => {
    const valid = next.filter((k) => allColumns.includes(k));
    if (valid.length === 0) return;
    setVisible(valid);
    try { localStorage.setItem(storageKey, JSON.stringify(valid)); } catch {}
  };

  return { visible, toggle, replaceAll };
}
