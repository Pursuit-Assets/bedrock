import { useState } from "react";

/** Stored layout: `visible` = user's chosen columns; `known` = every column
 *  that existed when the layout was saved. On load, any column added to the
 *  table since (`allColumns − known`) that is default-visible gets merged in —
 *  otherwise new columns stay invisible forever for anyone with a saved
 *  layout (TKT-128: the Opportunities "Owner" column was unreachable for
 *  long-time users). Legacy payloads were a bare array with no `known`, so
 *  they get a one-time merge with the current defaults. */
type StoredLayout<K extends string> = { visible: K[]; known: K[] };

function orderBy<K extends string>(cols: K[], allColumns: K[]): K[] {
  return [...new Set(cols)].sort(
    (a, b) => allColumns.indexOf(a) - allColumns.indexOf(b),
  );
}

export function useColumnVisibility<K extends string>(
  storageKey: string,
  allColumns: K[],
  defaultVisible?: K[],
) {
  const defaults = defaultVisible ?? allColumns;

  const persist = (visible: K[]) => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ visible, known: allColumns } satisfies StoredLayout<K>),
      );
    } catch {}
  };

  const [visible, setVisible] = useState<K[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as K[] | StoredLayout<K>;
        if (Array.isArray(parsed)) {
          // Legacy format — merge current defaults in once so columns added
          // since the layout was saved become visible again.
          const valid = parsed.filter((k) => allColumns.includes(k));
          if (valid.length > 0) {
            const merged = orderBy([...valid, ...defaults], allColumns);
            persist(merged);
            return merged;
          }
        } else if (parsed && Array.isArray(parsed.visible)) {
          const valid = parsed.visible.filter((k) => allColumns.includes(k));
          const known = Array.isArray(parsed.known) ? parsed.known : [];
          const newDefaults = allColumns.filter(
            (k) => !known.includes(k) && defaults.includes(k),
          );
          if (valid.length > 0 || newDefaults.length > 0) {
            const merged = orderBy([...valid, ...newDefaults], allColumns);
            if (newDefaults.length > 0) persist(merged);
            return merged;
          }
        }
      }
    } catch {}
    return [...defaults];
  });

  const toggle = (col: K) => {
    setVisible((prev) => {
      const next = prev.includes(col)
        ? prev.filter((k) => k !== col)
        : orderBy([...prev, col], allColumns);
      persist(next);
      return next;
    });
  };

  /** Replace the visible list wholesale — used by saved views.
   *  Filters out unknown keys so a stale view won't poison the table. */
  const replaceAll = (next: K[]) => {
    const valid = next.filter((k) => allColumns.includes(k));
    if (valid.length === 0) return;
    setVisible(valid);
    persist(valid);
  };

  return { visible, toggle, replaceAll };
}
