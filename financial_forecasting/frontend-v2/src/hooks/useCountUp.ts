import { useEffect, useRef, useState } from "react";

/**
 * Smoothly animates a number from 0 → target on mount and whenever `target`
 * changes, using requestAnimationFrame. No dependencies.
 *
 * Returns the current animated value. Respects prefers-reduced-motion by
 * snapping straight to the target.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const safeTarget = Number.isFinite(target) ? target : 0;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || durationMs <= 0) {
      setValue(safeTarget);
      fromRef.current = safeTarget;
      return;
    }

    const from = fromRef.current;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic — fast then settles, feels lively
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (safeTarget - from) * eased;
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = safeTarget;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      fromRef.current = safeTarget;
    };
  }, [target, durationMs]);

  return value;
}
