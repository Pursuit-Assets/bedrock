/**
 * JP's home page.
 *
 * Composition (top → bottom):
 *   1. PageHeader with a one-line summary.
 *   2. GoalTracker (left rail) + CalendarInboxSplit (main row).
 *   3. PriorityTable (below the fold).
 *   4. TaskDrawer + OpportunityDrawer mounted at root, controlled by
 *      clicks from any of the modules above.
 *
 * Everything heavy (calendar + inbox + priority table + recharts donut)
 * loads lazily so other owners' homes and the rest of the app stay light.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { OpportunityDrawer } from "@/components/OpportunityDrawer";
import { TaskDrawer, type FlatTask } from "@/components/TaskDrawer";
import { HomeErrorBoundary } from "@/components/home/HomeErrorBoundary";
import { HomeStatsStrip } from "@/components/home/HomeStatsStrip";
import { Scratchpad } from "@/components/home/Scratchpad";
import { useSalesforceStatus } from "@/services/auth";
import { usePermissions } from "@/services/permissions";
import type { SfOpportunity } from "@/types/salesforce";

/**
 * Identity gate — hard-coded while this page is in solo dogfood. Anyone
 * else hitting /home/jp (including admins) gets bounced to /dashboard.
 * Other owners can still see their own /home/<slug> pages.
 *
 * Matches on email *or* SF user id so a future email change (alias,
 * domain migration) doesn't lock JP out. Either match is enough.
 *
 * To open it up later: replace this constant with a permission key or
 * remove the gate entirely.
 */
const HOME_JP_GATE_EMAIL = "jp@pursuit.org";
/** Set when known. Leave empty string to disable the sf-user-id leg. */
const HOME_JP_GATE_SF_USER_ID = "";

const GoalTracker = lazy(() =>
  import("@/components/home/GoalTracker").then((m) => ({
    default: m.GoalTracker,
  })),
);
const CalendarInboxSplit = lazy(() =>
  import("@/components/home/CalendarInboxSplit").then((m) => ({
    default: m.CalendarInboxSplit,
  })),
);
const PriorityTable = lazy(() =>
  import("@/components/home/PriorityTable").then((m) => ({
    default: m.PriorityTable,
  })),
);

export function HomeJp() {
  const { data: permissions, isLoading } = usePermissions();
  const currentUserId = permissions?.sf_user_id ?? null;
  const qc = useQueryClient();
  const inFlight = useIsFetching({
    predicate: (q) => {
      const k = q.queryKey;
      if (!Array.isArray(k) || typeof k[0] !== "string") return false;
      return (
        k[0] === "my-tasks" ||
        k[0] === "opportunities" ||
        k[0] === "owner-goals" ||
        k[0] === "calendar-my-events"
      );
    },
  });
  const refreshing = inFlight > 0;

  const [drawerTask, setDrawerTask] = useState<FlatTask | null>(null);
  const [drawerOpp, setDrawerOpp] = useState<SfOpportunity | null>(null);

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["my-tasks"] });
    void qc.invalidateQueries({ queryKey: ["opportunities"] });
    void qc.invalidateQueries({ queryKey: ["owner-goals"] });
    void qc.invalidateQueries({ queryKey: ["calendar-my-events"] });
  }, [qc]);

  // Keyboard shortcut: `R` (no modifier, no input focused) refreshes all data.
  // Skipped when the user is typing in a textarea / input so it doesn't
  // hijack the Scratchpad or inline-edit fields.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let Cmd+R / Ctrl+R reload
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      refreshAll();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshAll]);

  // Wait for the auth/permissions response before deciding visibility so a
  // signed-in JP doesn't get bounced on a flash of empty data.
  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-5 py-4">
        <PaneSkeleton heightClass="h-[420px]" />
      </div>
    );
  }

  const viewerEmail = (permissions?.email ?? "").toLowerCase().trim();
  const viewerSfId = (permissions?.sf_user_id ?? "").trim();
  const allowed =
    viewerEmail === HOME_JP_GATE_EMAIL ||
    (HOME_JP_GATE_SF_USER_ID !== "" && viewerSfId === HOME_JP_GATE_SF_USER_ID);
  if (!allowed) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-5 py-4">
      <PageHeader
        title={greeting(permissions?.name)}
        subtitle="Calendar, inbox, priorities — your daily-work home base. Press R to refresh."
        actions={
          <button
            type="button"
            onClick={refreshAll}
            title="Refresh all data (R)"
            aria-label="Refresh data"
            aria-busy={refreshing}
            className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2"
          >
            <RefreshCw
              size={12}
              className={refreshing ? "animate-spin text-accent" : ""}
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      <HomeStatsStrip currentUserId={currentUserId} className="-mt-3 mb-1" />

      <SalesforceBanner />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-4">
          <HomeErrorBoundary section="Goal tracker">
            <Suspense fallback={<PaneSkeleton heightClass="h-[200px]" />}>
              <GoalTracker filterUserId={currentUserId} />
            </Suspense>
          </HomeErrorBoundary>
          <HomeErrorBoundary section="Scratchpad">
            <Scratchpad />
          </HomeErrorBoundary>
        </div>
        <HomeErrorBoundary section="Calendar + Inbox">
          <Suspense fallback={<PaneSkeleton heightClass="h-[420px]" />}>
            <CalendarInboxSplit
              currentUserId={currentUserId}
              onTaskClick={setDrawerTask}
              height="calc(100vh - 320px)"
              minHeight={420}
              maxHeight={760}
            />
          </Suspense>
        </HomeErrorBoundary>
      </div>

      <HomeErrorBoundary section="Priority table">
        <Suspense fallback={<PaneSkeleton heightClass="h-[400px]" />}>
          <PriorityTable
            currentUserId={currentUserId}
            onOpportunityClick={setDrawerOpp}
          />
        </Suspense>
      </HomeErrorBoundary>

      <TaskDrawer task={drawerTask} onClose={() => setDrawerTask(null)} />
      <OpportunityDrawer
        opportunity={drawerOpp}
        onClose={() => setDrawerOpp(null)}
      />
    </div>
  );
}

/** Surfaced when the backend reports Salesforce is disconnected so the
 *  user understands why downstream modules are empty. Skipped while the
 *  status query is loading (don't flash a banner that won't apply). */
function SalesforceBanner() {
  const { data, isLoading } = useSalesforceStatus();
  if (isLoading) return null;
  if (data?.connected) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-amber/40 bg-amber-soft px-3 py-2 text-[12px] text-ink"
    >
      <AlertTriangle size={13} className="flex-shrink-0 text-amber" />
      <span className="flex-1">
        {data?.needs_reconnect
          ? "Salesforce session expired. Reconnect to see opportunities and tasks."
          : "Salesforce isn't connected. Opportunities and tasks won't load until you sign in."}
      </span>
      <a
        href="/auth/salesforce/login"
        className="rounded border border-amber/60 bg-surface px-2 py-0.5 text-[11px] font-semibold text-amber hover:bg-amber-soft"
      >
        Connect
      </a>
    </div>
  );
}

/** Time-of-day greeting using the user's first name. Falls back to a
 *  neutral title when permissions are still loading or name is missing. */
function greeting(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const who = first || "JP";
  const hour = new Date().getHours();
  if (hour < 5) return `Up late, ${who}`;
  if (hour < 12) return `Good morning, ${who}`;
  if (hour < 17) return `Good afternoon, ${who}`;
  if (hour < 21) return `Good evening, ${who}`;
  return `Wrap-up, ${who}`;
}

function PaneSkeleton({ heightClass }: { heightClass: string }) {
  return (
    <div
      className={`w-full animate-pulse rounded-lg bg-surface-2 ${heightClass}`}
      aria-busy
    />
  );
}

// Default export kept for compatibility with the previous stub; the
// named export is the contract `slugs.ts` imports via React.lazy.
export default HomeJp;
