import { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { usePermissions } from "@/services/permissions";

/**
 * Route-level launch-dark gate for Pebble.
 *
 * Renders children only when the current user has `pebble_access` (i.e.,
 * jp@pursuit.org as of 2026-05-18). Anyone else is redirected to
 * /dashboard with no error toast — the route should feel like it doesn't
 * exist, not like the user got a 403.
 *
 * The sidebar nav entry is hidden via the same gate in AppShell, so a
 * normal user has no path to even hit this route. This component is the
 * defense in depth for bookmarks, manual URL entry, and any future
 * deep links that bypass the sidebar.
 *
 * Loading state: returns null (no flash of content) until
 * /api/permissions/me resolves. usePermissions has a 5-minute staleTime
 * so subsequent navigations are instant.
 */
export function PebbleAccessGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = usePermissions();
  if (isLoading) return null;
  if (data?.permissions?.pebble_access !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
