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

  // Prefer the list-derived unread count over the lightweight badge
  // query — the panel and the action button should stay in sync with
  // what the user is looking at. The badge query is still used as the
  // initial seed before the list loads.
  const items = listQ.data ?? [];
  const listUnread = items.reduce((n, x) => n + (x.read_at ? 0 : 1), 0);
  const unread = items.length > 0 ? listUnread : countQ.data ?? 0;

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
      // Bell now lives in the top bar — prefer opening DOWNWARD (the
      // common case). Falls back to above only if the panel would
      // overflow below the viewport.
      const spaceBelow = vh - rect.bottom - PANEL_MARGIN;
      let top: number;
      if (spaceBelow >= panelHeight || rect.top < panelHeight + PANEL_MARGIN) {
        top = rect.bottom + PANEL_MARGIN;
      } else {
        top = rect.top - panelHeight - PANEL_MARGIN;
      }
      // Right-align the panel to the trigger so the dropdown extends
      // leftward (avoids overflowing the right edge of the viewport
      // since the bell sits in the top-right corner).
      let left = rect.right - PANEL_WIDTH;
      left = Math.max(PANEL_MARGIN, Math.min(vw - PANEL_WIDTH - PANEL_MARGIN, left));
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
    setOpen(false);
    const url = resolveTargetUrl(n);
    if (!url) return;
    if (/^https?:\/\//.test(url)) {
      window.location.href = url;
      return;
    }
    // Two-phase handoff so the click reliably opens the task drawer
    // regardless of where the user starts:
    //
    //   (a) sessionStorage — survives a route change. ProjectDetail
    //       reads + clears it on mount, so navigating from /portfolio
    //       to /projects/<id> still pops the drawer.
    //   (b) CustomEvent     — handles the same-page case where
    //       react-router no-ops on identical URLs. ProjectDetail's
    //       listener pops the drawer directly if the task belongs to
    //       this project.
    const taskId = n.payload?.task_id ?? n.payload?.entity_id ?? null;
    if (taskId) {
      try {
        sessionStorage.setItem("bedrock:pending-task-open", String(taskId));
      } catch {
        /* private-mode safari — fall through to the event */
      }
      window.dispatchEvent(
        new CustomEvent("bedrock:open-task", { detail: { taskId } }),
      );
    }
    navigate(url);
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
        <button
          type="button"
          onClick={() => unread > 0 && markAllRead.mutate()}
          disabled={markAllRead.isPending || unread === 0}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-3 hover:text-accent disabled:cursor-not-allowed disabled:text-ink-4 disabled:hover:text-ink-4"
          title={unread > 0 ? "Mark all as read" : "Nothing to mark — you're caught up"}
        >
          <MailCheck size={11} aria-hidden /> Mark all read
        </button>
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
  const p = n.payload ?? {};
  const actor = p.actor_display_name || n.actor_email || "Someone";

  // Headline + structured detail rows mirror the Slack message layout.
  let headline = "";
  let details: { label: string; value: string; bold?: boolean }[] = [];
  if (n.type === "project_task_assigned") {
    headline = `${actor} assigned you a task`;
    if (p.project_name) details.push({ label: "Project", value: p.project_name });
    if (p.workstream_name) details.push({ label: "Workstream", value: p.workstream_name });
    if (p.milestone_title) details.push({ label: "Milestone", value: p.milestone_title });
    if (p.task_title || p.subtitle) {
      details.push({ label: "Task", value: p.task_title || p.subtitle || "", bold: true });
    }
  } else if (n.type === "comment_mention") {
    headline = `${actor} mentioned you in a comment`;
    if (p.project_name) details.push({ label: "Project", value: p.project_name });
    if (p.task_title) details.push({ label: "Task", value: p.task_title });
    const body = p.comment_body || p.subtitle || "";
    if (body) details.push({ label: "Comment", value: body, bold: true });
  } else if (n.type === "sf_task_assigned") {
    headline = `${actor} assigned you a Salesforce task`;
    if (p.what_name) details.push({ label: "Related", value: p.what_name });
    if (p.activity_date) details.push({ label: "Due", value: p.activity_date });
    const task = p.task_title || p.subtitle || "";
    if (task) details.push({ label: "Task", value: task, bold: true });
  } else if (n.type === "sf_opp_owner_changed") {
    const role = p.role;
    const oppName = p.opp_name || p.subtitle || "";
    if (role === "gained") {
      headline = `${actor} made you the owner`;
      if (oppName) details.push({ label: "Opportunity", value: oppName, bold: true });
    } else if (role === "lost") {
      headline = `${actor} reassigned an opportunity`;
      if (oppName) details.push({ label: "Opportunity", value: oppName });
      if (p.new_owner_name) details.push({ label: "Now owned by", value: p.new_owner_name });
    } else {
      headline = "Opportunity ownership changed";
      if (oppName) details.push({ label: "", value: oppName });
    }
  } else {
    headline = p.title || prettyType(n.type);
    if (p.subtitle) details.push({ label: "", value: p.subtitle });
  }

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
              {headline}
            </span>
            {time ? (
              <span className="ml-auto flex-shrink-0 text-[10.5px] text-ink-3">{time}</span>
            ) : null}
          </div>
          {details.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {details.map((d, i) => (
                <li key={i} className="text-[11.5px] text-ink-3 line-clamp-2">
                  {d.label ? <span className="font-semibold text-ink-2">{d.label}:</span> : null}
                  {d.label ? " " : ""}
                  <span className={cn(d.bold && "font-semibold text-ink-2")}>{d.value}</span>
                </li>
              ))}
            </ul>
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
