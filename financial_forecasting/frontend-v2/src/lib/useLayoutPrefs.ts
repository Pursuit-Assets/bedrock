/**
 * Typed localStorage prefs hook for per-surface layout state.
 *
 * Surface-namespace your `storageKey` (e.g., `"bedrock:home:jp"` for JP's
 * home page) so per-user / per-surface prefs never collide.
 *
 * The hook tolerates corrupt JSON (returns defaults), is SSR-safe, and
 * persists `null`-cleared or default-equal values by removing the key
 * rather than writing it.
 *
 * Sibling to `useSessionState` (which clears on tab close); use this when
 * the pref must survive a tab close — layout widths, view modes, etc.
 */
import { useCallback, useState } from "react";

function read<T extends object>(key: string, defaults: T): T {
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return defaults;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Merge so newly-added keys in `defaults` flow into stored prefs.
      return { ...defaults, ...(parsed as Partial<T>) };
    }
    return defaults;
  } catch {
    return defaults;
  }
}

function write<T extends object>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / private-mode errors
  }
}

function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function useLayoutPrefs<T extends object>(
  storageKey: string,
  defaults: T,
): {
  prefs: T;
  setPrefs: (patch: Partial<T>) => void;
  reset: () => void;
} {
  const [prefs, setLocal] = useState<T>(() => read(storageKey, defaults));

  const setPrefs = useCallback(
    (patch: Partial<T>) => {
      setLocal((prev) => {
        const next = { ...prev, ...patch };
        write(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    remove(storageKey);
    setLocal(defaults);
  }, [storageKey, defaults]);

  return { prefs, setPrefs, reset };
}
