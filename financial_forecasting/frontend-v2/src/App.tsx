import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Toaster } from "sonner";

import { AppShell } from "./components/AppShell";
import { AuthGate } from "./components/AuthGate";
import { LoginPage } from "./pages/Login";
import { PageSkeleton } from "./components/PageSkeleton";
import { PebbleFloatingBox } from "./components/pebble/PebbleFloatingBox";
import { usePermissions } from "./services/permissions";

/**
 * Per-owner default landing. Keyed by lowercased email. Anyone whose
 * email isn't in this map falls through to `/dashboard` (the global
 * default). Add yourself here when your `/home/<slug>` page is real
 * enough to be your homepage.
 */
const PERSONAL_HOME_BY_EMAIL: Record<string, string> = {
  "jp@pursuit.org": "/home/jp",
};

const DEFAULT_LANDING = "/dashboard";

/** Resolve the right landing page for the current user. */
function RootRedirect() {
  const { data, isLoading } = usePermissions();
  if (isLoading) return <PageSkeleton />;
  const email = (data?.email ?? "").toLowerCase().trim();
  const dest = PERSONAL_HOME_BY_EMAIL[email] ?? DEFAULT_LANDING;
  return <Navigate to={dest} replace />;
}

/**
 * Identity gate for the Pebble floating toolbox.
 *
 * Pebble is JP's dogfood surface while the engine is still in flight,
 * so it mounts globally for him on every authenticated route (Dashboard,
 * Pipeline, Account detail, etc.) but stays invisible to everyone else.
 * Add an email here when their owner profile is ready for Pebble.
 */
const PEBBLE_ALLOWED_EMAILS = new Set(["jp@pursuit.org"]);

function PebbleGate() {
  const { data } = usePermissions();
  const email = (data?.email ?? "").toLowerCase().trim();
  if (!PEBBLE_ALLOWED_EMAILS.has(email)) return null;
  return <PebbleFloatingBox />;
}

/**
 * Route-level code splitting.
 *
 * Every authenticated page is `React.lazy`-loaded. Vite/Rollup turns each
 * dynamic import into its own chunk so the initial bundle only carries
 * the shell + the route a user actually opens. Vendor libraries used
 * exclusively by one route (e.g., `recharts`, `react-resizable-panels`)
 * follow their importing route into that chunk.
 *
 * Kept eager: `AppShell`, `AuthGate`, `LoginPage` — the entry surfaces
 * every cold start needs immediately. Splitting them would just add a
 * loading flash on the very first frame.
 *
 * `React.lazy` requires a default export; v2 pages export named symbols
 * (e.g., `DashboardPage`), so each dynamic import maps the named export
 * onto `default` inline.
 */
const DashboardPage = lazy(() =>
  import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })),
);
const AccountsPage = lazy(() =>
  import("./pages/Accounts").then((m) => ({ default: m.AccountsPage })),
);
const AccountDetailPage = lazy(() =>
  import("./pages/AccountDetail").then((m) => ({ default: m.AccountDetailPage })),
);
const PipelinePage = lazy(() =>
  import("./pages/Pipeline").then((m) => ({ default: m.PipelinePage })),
);
const CleanupPage = lazy(() =>
  import("./pages/Cleanup").then((m) => ({ default: m.CleanupPage })),
);
const OpportunityDetailPage = lazy(() =>
  import("./pages/OpportunityDetail").then((m) => ({
    default: m.OpportunityDetailPage,
  })),
);
const AwardsPage = lazy(() =>
  import("./pages/Awards").then((m) => ({ default: m.AwardsPage })),
);
const AwardDetailPage = lazy(() =>
  import("./pages/AwardDetail").then((m) => ({ default: m.AwardDetailPage })),
);
const ProjectsPage = lazy(() =>
  import("./pages/Projects").then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import("./pages/ProjectDetail").then((m) => ({ default: m.ProjectDetailPage })),
);
const TasksPage = lazy(() =>
  import("./pages/Tasks").then((m) => ({ default: m.TasksPage })),
);
const ContactsPage = lazy(() =>
  import("./pages/Contacts").then((m) => ({ default: m.ContactsPage })),
);
const ContactDetailPage = lazy(() =>
  import("./pages/ContactDetail").then((m) => ({ default: m.ContactDetailPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.SettingsPage })),
);
const CashFlowPage = lazy(() =>
  import("./pages/CashFlow").then((m) => ({ default: m.CashFlowPage })),
);
const PlatformIntakePage = lazy(() =>
  import("./pages/PlatformIntake").then((m) => ({
    default: m.PlatformIntakePage,
  })),
);
const PortfolioPage = lazy(() =>
  import("./pages/Portfolio").then((m) => ({ default: m.PortfolioPage })),
);
const HomePage = lazy(() =>
  import("./pages/home").then((m) => ({ default: m.HomePage })),
);
const HomeIndexPage = lazy(() =>
  import("./pages/home").then((m) => ({ default: m.HomeIndexPage })),
);

/** Single Suspense boundary inside the authenticated shell so route
 *  transitions render the same skeleton wherever they land. */
function RouteSuspense() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Outlet />
    </Suspense>
  );
}

export default function App() {
  return (
    <>
      <Toaster position="bottom-right" richColors closeButton />
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<LoginPage />} />

        {/* Authenticated routes */}
        <Route
          element={
            <AuthGate>
              <AppShell />
              <PebbleGate />
            </AuthGate>
          }
        >
          <Route element={<RouteSuspense />}>
            <Route index element={<RootRedirect />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/accounts/:id" element={<AccountDetailPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/cleanup" element={<CleanupPage />} />
            <Route path="/opportunities/:id" element={<OpportunityDetailPage />} />
            <Route path="/awards" element={<AwardsPage />} />
            <Route path="/awards/:id" element={<AwardDetailPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/cashflow" element={<CashFlowPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/portfolio/:identifier" element={<PortfolioPage />} />
            <Route path="/feedback" element={<PlatformIntakePage />} />
            <Route path="/home" element={<HomeIndexPage />} />
            <Route path="/home/:slug" element={<HomePage />} />
            <Route path="/settings" element={<SettingsPage />} />

            {/* Backend redirects to /priorities after Google OAuth — route
                through the per-owner landing resolver so JP (and any future
                allowlisted email) lands on their home instead. */}
            <Route path="/priorities" element={<RootRedirect />} />

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}
