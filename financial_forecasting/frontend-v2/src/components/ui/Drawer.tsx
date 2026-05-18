import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

const KEYBOARD_NUDGE_PX = 16;

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  linkTo?: string;
  children: ReactNode;
  /** Fixed width when `resizable` is false (default). Initial width when `resizable` is true. */
  width?: number;
  /** Allow drag-resize via a left-edge handle. */
  resizable?: boolean;
  /** Min width when resizable. */
  minWidth?: number;
  /** Max width when resizable. */
  maxWidth?: number;
  /**
   * localStorage key for resized width. Required when `resizable` is true if
   * you want persistence; if omitted, width resets to `width` on mount.
   */
  storageKey?: string;
}

/**
 * Right-side detail drawer. Click outside or press Escape to close.
 *
 * Header takes a `linkTo` for the "open full page" affordance — keeps
 * the deep-link route working alongside the drawer UX.
 *
 * When `resizable` is set, a left-edge handle drags the width within
 * `[minWidth, maxWidth]` and persists to `storageKey`. Keyboard: focus
 * the handle, then `←`/`→` nudge ±16px (`Home`/`End` jump to bounds).
 * The handle is a `role="separator"` with `aria-orientation="vertical"`.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  linkTo,
  children,
  width = 640,
  resizable = false,
  minWidth = 360,
  maxWidth = 800,
  storageKey,
}: DrawerProps) {
  const clamp = useCallback(
    (px: number) => Math.min(maxWidth, Math.max(minWidth, px)),
    [minWidth, maxWidth],
  );

  const [resizedWidth, setResizedWidth] = useState<number>(() => {
    if (!resizable) return width;
    if (typeof window === "undefined") return width;
    if (storageKey) {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) return clamp(parsed);
      }
    }
    return clamp(width);
  });

  const persist = useCallback(
    (px: number) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, String(px));
      } catch {
        // ignore quota / private-mode errors
      }
    },
    [storageKey],
  );

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      dragStateRef.current = { startX: e.clientX, startWidth: resizedWidth };
    },
    [resizedWidth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      // Drawer is anchored right — dragging the handle leftward grows width.
      const next = clamp(drag.startWidth + (drag.startX - e.clientX));
      setResizedWidth(next);
    },
    [clamp],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      dragStateRef.current = null;
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        // releasePointerCapture can throw if not captured
      }
      persist(resizedWidth);
    },
    [persist, resizedWidth],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let next = resizedWidth;
      if (e.key === "ArrowLeft") next = clamp(resizedWidth + KEYBOARD_NUDGE_PX);
      else if (e.key === "ArrowRight") next = clamp(resizedWidth - KEYBOARD_NUDGE_PX);
      else if (e.key === "Home") next = maxWidth;
      else if (e.key === "End") next = minWidth;
      else return;
      e.preventDefault();
      setResizedWidth(next);
      persist(next);
    },
    [resizedWidth, clamp, minWidth, maxWidth, persist],
  );

  const effectiveWidth = resizable ? resizedWidth : width;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px] transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          "fixed bottom-0 right-0 top-0 z-50 flex flex-col bg-surface shadow-lg transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
        style={{ width: effectiveWidth }}
      >
        {resizable ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize drawer"
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={effectiveWidth}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            className="group absolute -left-1 top-0 h-full w-2 cursor-col-resize select-none focus:outline-none"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-border-strong transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
            />
          </div>
        ) : null}

        <header className="flex flex-shrink-0 items-start gap-2 border-b border-border-strong bg-surface px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-semibold leading-tight">{title}</div>
            {subtitle ? (
              <div className="mt-0.5 truncate text-[12px] text-ink-3">{subtitle}</div>
            ) : null}
          </div>
          {linkTo ? (
            <Link
              to={linkTo}
              className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2"
              title="Open full page"
            >
              <ExternalLink size={12} /> Open
            </Link>
          ) : null}
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}
