import { useState } from "react";

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K | null;
  direction: SortDirection;
}

export function useSort<K extends string>(
  initial: SortState<K> = { key: null, direction: "asc" },
) {
  const [sort, setSort] = useState<SortState<K>>(initial);

  const toggle = (key: K) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return { key: null, direction: "asc" }; // third click clears
    });
  };

  return { sort, toggle, setSort };
}

/**
 * Generic comparator for table sorting. Handles strings, numbers, dates,
 * nulls (always sorted last), and booleans.
 */
export function compare(a: unknown, b: unknown, direction: SortDirection): number {
  const dir = direction === "asc" ? 1 : -1;

  // Nulls always last regardless of direction
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  // Numbers
  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * dir;
  }
  // Booleans (true > false)
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (Number(a) - Number(b)) * dir;
  }
  // Try date-coerce: ISO strings parse cleanly. If both parse to a real
  // date, compare as dates; otherwise fall through to string compare.
  const aDate = parseAsDate(a);
  const bDate = parseAsDate(b);
  if (aDate != null && bDate != null) {
    return (aDate - bDate) * dir;
  }
  // String fallback
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  if (as < bs) return -1 * dir;
  if (as > bs) return 1 * dir;
  return 0;
}

function parseAsDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  // Cheap heuristic: must look like an ISO date (YYYY-MM-DD or with T)
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Sort an array by a key extractor. Returns a NEW array.
 */
export function sortBy<T, K extends string>(
  rows: T[],
  state: SortState<K>,
  extract: (row: T, key: K) => unknown,
): T[] {
  if (!state.key) return rows;
  const key = state.key;
  const dir = state.direction;
  return [...rows].sort((a, b) => compare(extract(a, key), extract(b, key), dir));
}
