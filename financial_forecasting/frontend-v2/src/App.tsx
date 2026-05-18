import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import { AppShell } from "./components/AppShell";
import { AuthGate } from "./components/AuthGate";
import { DashboardPage } from "./pages/Dashboard";
import { AccountsPage } from "./pages/Accounts";
import { AccountDetailPage } from "./pages/AccountDetail";
import { PipelinePage } from "./pages/Pipeline";
import { CleanupPage } from "./pages/Cleanup";
import { OpportunityDetailPage } from "./pages/OpportunityDetail";
import { AwardsPage } from "./pages/Awards";
import { AwardDetailPage } from "./pages/AwardDetail";
import { ProjectsPage } from "./pages/Projects";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { TasksPage } from "./pages/Tasks";
import { ContactsPage } from "./pages/Contacts";
import { ContactDetailPage } from "./pages/ContactDetail";
import { LoginPage } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";
import { CashFlowPage } from "./pages/CashFlow";
import { PlatformIntakePage } from "./pages/PlatformIntake";
import { PortfolioPage } from "./pages/Portfolio";
import { HomePage, HomeIndexPage } from "./pages/home";

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
          </AuthGate>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
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

        {/* Backend redirects to /priorities after Google OAuth — alias it */}
        <Route path="/priorities" element={<Navigate to="/dashboard" replace />} />

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
    </>
  );
}
