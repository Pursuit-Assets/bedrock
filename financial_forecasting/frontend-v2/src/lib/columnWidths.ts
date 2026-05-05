import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-table column widths persisted in localStorage. Returns the current
 * widths plus a pointer-down handler to wire onto a drag handle on the
 * right edge of each <th>.
 *
 * Use with <colgroup> + `table-layout: fixed` so the browser uses these
 * widths authoritatively and the table doesn't reflow on data change.
 */
export function useColumnWidths<K extends string>(
  storageKey: string,
  defaults: Record<K, number>,
  options: { min?: number; max?: number } = {},
) {
  const min = options.min ?? 60;
  const max = options.max ?? 800;

  const [widths, setWidths] = useState<Record<K, number>>(() => {
    if (typeof window === "undefined") return defaults;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<Record<K, number>>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  // Persist (debounced via the next render — JSON.stringify of a small
  // object is cheap, no need for explicit debouncing).
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // localStorage full or disabled — ignore
    }
  }, [widths, storageKey]);

  // We use refs in the move handler so we don't capture a stale `widths`.
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const startResize = useCallback(
    (key: K, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widthsRef.current[key];

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.min(max, Math.max(min, startW + delta));
        setWidths((w) => (w[key] === next ? w : { ...w, [key]: next }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [min, max],
  );

  const reset = useCallback(() => setWidths(defaults), [defaults]);

  /** Replace the widths wholesale — used when loading a saved view.
   *  Falls back to the per-key default for any keys the saved value
   *  doesn't cover (so adding a new column doesn't break old views). */
  const replaceAll = useCallback(
    (next: Partial<Record<K, number>>) => {
      setWidths({ ...defaults, ...next });
    },
    [defaults],
  );

  return { widths, startResize, reset, replaceAll };
}

/**
 * Sum of the column widths — used to set the table's min-width so the
 * overflow-x-auto scroll container scrolls horizontally when needed.
 */
export function totalWidth<K extends string>(widths: Record<K, number>): number {
  return Object.values(widths).reduce<number>((s, n) => s + (n as number), 0);
}
