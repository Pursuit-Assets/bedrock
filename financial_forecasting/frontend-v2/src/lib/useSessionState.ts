/**
 * useState that persists to sessionStorage. Survives component
 * unmount/remount (e.g. navigating away and back) but resets on
 * tab close. Key is scoped by the caller — use a page-specific
 * prefix like `"pipeline:expandedId"`.
 */
import { useState, useCallback } from "react";

export function useSessionState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setStateInner] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored) as T;
    } catch {}
    return defaultValue;
  });

  const setState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStateInner((prev) => {
        const next = typeof value === "function" ? (value as (p: T) => T)(prev) : value;
        try {
          if (next === null || next === defaultValue) {
            sessionStorage.removeItem(key);
          } else {
            sessionStorage.setItem(key, JSON.stringify(next));
          }
        } catch {}
        return next;
      });
    },
    [key, defaultValue],
  );

  return [state, setState];
}
