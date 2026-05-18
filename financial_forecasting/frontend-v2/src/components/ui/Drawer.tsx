import { type ReactNode, useEffect } from "react";
import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * Right-side detail drawer. Click outside or press Escape to close.
 *
 * Header takes a `linkTo` for the "open full page" affordance — keeps
 * the deep-link route working alongside the drawer UX.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  linkTo,
  children,
  width = 640,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  linkTo?: string;
  children: ReactNode;
  width?: number;
}) {
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
        style={{ width }}
      >
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
