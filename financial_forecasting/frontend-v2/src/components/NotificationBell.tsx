import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, MailCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
  type BedrockNotification,
  type NotificationType,
} from "@/services/notifications";

const PANEL_WIDTH = 360;
const PANEL_MARGIN = 8;

/** In-app notification bell rendered in the AppShell. Polls
 *  /api/notifications + /api/notifications/unread-count every 30s
 *  (more often on focus). Click → dropdown of the 50 most-recent
 *  notifications; clicking a row marks it read and navigates to the
 *  payload.target_url when set. */
export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Panel coords are computed against the trigger's viewport rect and
  // applied as fixed positioning. We portal to document.body so the
  // sidebar's overflow-hidden can't clip the dropdown.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const countQ = useUnreadNotificationCount();
  const listQ = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unread = countQ.data ?? 0;
  const items = listQ.data ?? [];

  // Position the panel anchored to the trigger. Bell sits in the
  // sidebar's bottom row, so we open the panel UPWARD by default —
  // anchored to the trigger's top edge, extending toward the right
  // (clamped to viewport).
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const panelHeight = panel?.offsetHeight ?? 420;
      // Prefer opening above the bell when there's not enough space
      // below (the common case — bell lives at the bottom of the
      // sidebar). Falls back to below otherwise.
      const spaceBelow = vh - rect.bottom - PANEL_MARGIN;
      let top: number;
      if (spaceBelow < panelHeight && rect.top > panelHeight + PANEL_MARGIN) {
        top = rect.top - panelHeight - PANEL_MARGIN;
      } else {
        top = rect.bottom + PANEL_MARGIN;
      }
      // Open toward the right of the bell (escapes the sidebar).
      let left = rect.right + PANEL_MARGIN;
      if (left + PANEL_WIDTH > vw - PANEL_MARGIN) {
        // Not enough horizontal room — anchor under/over the trigger
        // and clamp to the viewport's right edge.
        left = Math.max(PANEL_MARGIN, vw - PANEL_WIDTH - PANEL_MARGIN);
      }
      top = Math.max(PANEL_MARGIN, Math.min(vh - panelHeight - PANEL_MARGIN, top));
      setCoords({ top, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, items.length]);

  // Close-on-outside-click — checks both the trigger and the panel
  // since the panel is portaled outside the trigger's DOM subtree.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        panelRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function handleRowClick(n: BedrockNotification) {
    if (!n.read_at) markRead.mutate(n.id);
    const url = resolveTargetUrl(n);
    if (url) {
      // navigate(absolute URLs as full reload, in-app paths via SPA router)
      if (/^https?:\/\//.test(url)) {
        window.location.href = url;
      } else {
        navigate(url);
      }
      setOpen(false);
    }
  }

  const panel = open ? (
    <div
      ref={panelRef}
      role="menu"
      className="fixed z-50 w-[360px] rounded-lg border border-border-strong bg-surface shadow-xl"
      style={{
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        visibility: coords ? "visible" : "hidden",
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-strong px-3 py-2">
        <span className="text-[12.5px] font-semibold text-ink">Notifications</span>
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3 hover:text-accent disabled:opacity-60"
            title="Mark all as read"
          >
            <MailCheck size={11} aria-hidden /> Mark all read
          </button>
        ) : null}
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {listQ.isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-ink-3">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-ink-3">
            You're all caught up.
          </div>
        ) : (
          <ul className="divide-y divide-border-strong">
            {items.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                onClick={() => handleRowClick(n)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
        title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        aria-label="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell size={16} aria-hidden />
        {unread > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red px-1 text-[9px] font-bold leading-none text-white"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
}

function NotificationRow({
  n,
  onClick,
}: {
  n: BedrockNotification;
  onClick: () => void;
}) {
  const isUnread = !n.read_at;
  const icon = typeIcon(n.type);
  const time = useRelativeTime(n.created_at);

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2",
          isUnread && "bg-blue-50/60",
        )}
      >
        <span className="mt-0.5 select-none text-[14px]" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn(
              "truncate text-[12.5px]",
              isUnread ? "font-semibold text-ink" : "font-medium text-ink-2",
            )}>
              {n.payload.title || prettyType(n.type)}
            </span>
            {time ? (
              <span className="ml-auto flex-shrink-0 text-[10.5px] text-ink-3">{time}</span>
            ) : null}
          </div>
          {n.payload.subtitle ? (
            <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-3">
              {n.payload.subtitle}
            </div>
          ) : null}
          {n.actor_email ? (
            <div className="mt-0.5 text-[10.5px] text-ink-4">{n.actor_email}</div>
          ) : null}
        </div>
        {isUnread ? (
          <span
            className="mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent"
            aria-label="unread"
          />
        ) : null}
      </button>
    </li>
  );
}

/** Defensive URL resolution. Older notifications were enqueued before
 *  the backend started populating `target_url`; fall back to building
 *  a sensible deep-link from whatever IDs are on the payload. */
function resolveTargetUrl(n: BedrockNotification): string | null {
  const p = n.payload ?? {};
  if (p.target_url) return p.target_url;
  const projectId = p.project_id ?? null;
  const taskId = p.task_id ?? p.entity_id ?? null;
  if (projectId && taskId) return `/projects/${projectId}?task=${taskId}`;
  if (projectId) return `/projects/${projectId}`;
  return null;
}

function typeIcon(t: NotificationType): string {
  switch (t) {
    case "project_task_assigned":
      return "📋";
    case "comment_mention":
      return "💬";
    case "sf_task_assigned":
      return "🔔";
    case "sf_opp_owner_changed":
      return "🤝";
  }
}

function prettyType(t: NotificationType): string {
  switch (t) {
    case "project_task_assigned":
      return "Task assigned";
    case "comment_mention":
      return "Mention";
    case "sf_task_assigned":
      return "New Salesforce task";
    case "sf_opp_owner_changed":
      return "Opportunity owner change";
  }
}

/** Compact "5m" / "2h" / "Yesterday" relative-time label. */
function useRelativeTime(iso: string | null): string {
  return useMemo(() => {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diffSec = Math.max(0, (Date.now() - t) / 1000);
    if (diffSec < 45) return "just now";
    if (diffSec < 60 * 60) return `${Math.round(diffSec / 60)}m`;
    if (diffSec < 60 * 60 * 24) return `${Math.round(diffSec / 3600)}h`;
    if (diffSec < 60 * 60 * 24 * 2) return "Yesterday";
    if (diffSec < 60 * 60 * 24 * 7) return `${Math.floor(diffSec / 86400)}d`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }, [iso]);
}
