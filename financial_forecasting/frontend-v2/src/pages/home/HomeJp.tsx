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
import { lazy, Suspense, useState } from "react";
import { Navigate } from "react-router-dom";

import { PageHeader } from "@/components/PageHeader";
import { OpportunityDrawer } from "@/components/OpportunityDrawer";
import { TaskDrawer, type FlatTask } from "@/components/TaskDrawer";
import { usePermissions } from "@/services/permissions";
import type { SfOpportunity } from "@/types/salesforce";

/**
 * Identity gate — hard-coded while this page is in solo dogfood. Anyone
 * else hitting /home/jp (including admins) gets bounced to /dashboard.
 * Other owners can still see their own /home/<slug> pages.
 *
 * To open it up later: replace this constant with a permission key or
 * remove the gate entirely.
 */
const HOME_JP_GATE_EMAIL = "jp@pursuit.org";

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

  const [drawerTask, setDrawerTask] = useState<FlatTask | null>(null);
  const [drawerOpp, setDrawerOpp] = useState<SfOpportunity | null>(null);

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
  if (viewerEmail !== HOME_JP_GATE_EMAIL) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-5 py-4">
      <PageHeader
        title="JP's home"
        subtitle="Today's calendar, your inbox, and the weighted priorities under one roof."
      />

      <Suspense fallback={<PaneSkeleton heightClass="h-[420px]" />}>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
          <Suspense fallback={<PaneSkeleton heightClass="h-[200px]" />}>
            <GoalTracker filterUserId={currentUserId} />
          </Suspense>
          <CalendarInboxSplit
            currentUserId={currentUserId}
            onTaskClick={setDrawerTask}
            height="calc(100vh - 320px)"
            minHeight={420}
            maxHeight={760}
          />
        </div>
      </Suspense>

      <Suspense fallback={<PaneSkeleton heightClass="h-[400px]" />}>
        <PriorityTable
          currentUserId={currentUserId}
          onOpportunityClick={setDrawerOpp}
        />
      </Suspense>

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
