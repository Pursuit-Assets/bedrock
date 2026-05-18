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
import { RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { OpportunityDrawer } from "@/components/OpportunityDrawer";
import { TaskDrawer, type FlatTask } from "@/components/TaskDrawer";
import { HomeErrorBoundary } from "@/components/home/HomeErrorBoundary";
import { Scratchpad } from "@/components/home/Scratchpad";
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
        title="JP's home"
        subtitle="Today's calendar, your inbox, and the weighted priorities under one roof."
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
