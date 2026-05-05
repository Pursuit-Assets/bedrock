import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface CurrentUser {
  email: string;
  name: string;
  picture?: string;
  sub: string;
  salesforce_connected?: boolean;
  salesforce_user_id?: string | null;
  salesforce_user_name?: string | null;
  google_connected?: boolean;
  google_email?: string;
  slack_configured?: boolean;
  slack_workspace?: string | null;
}

export interface SalesforceStatus {
  connected: boolean;
  user_id?: string;
  user_name?: string;
  instance_url?: string;
  message?: string;
  needs_reconnect?: boolean;
  refreshed?: boolean;
}

/** Fetch the logged-in user, or null on 401. */
async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const { data } = await api.get<CurrentUser>("/auth/me");
    return data;
  } catch {
    return null;
  }
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchCurrentUser,
    staleTime: 30_000,
    retry: false,
  });
}

async function fetchSalesforceStatus(): Promise<SalesforceStatus> {
  const { data } = await api.get<SalesforceStatus>("/auth/salesforce/status");
  return data;
}

export function useSalesforceStatus() {
  return useQuery({
    queryKey: ["auth", "salesforce-status"],
    queryFn: fetchSalesforceStatus,
    staleTime: 15_000,
  });
}

export function useDisconnectSalesforce() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/salesforce/disconnect"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      qc.clear();
      window.location.href = "/login";
    },
  });
}

/**
 * Build the URL the browser should navigate to in order to start an OAuth
 * flow. Backend uses `${FRONTEND_URL}/...` for callback redirects, so
 * leave the path empty here and let `window.location.href` handle the
 * cross-origin jump.
 */
export const apiBaseURL = import.meta.env.VITE_API_URL || "";

/**
 * Pick the base URL for top-level OAuth navigations. In production
 * `VITE_API_URL` is empty (we proxy /auth and /api through nginx so
 * the cookie is first-party), so use same-origin paths. In dev, hit
 * the FastAPI backend on :8000 directly because Vite doesn't proxy
 * /auth.
 */
function oauthBase(): string {
  if (apiBaseURL) return apiBaseURL;
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "http://localhost:8000";
  }
  return "";
}

export function startGoogleLogin(): void {
  window.location.href = `${oauthBase()}/auth/google`;
}

export function startSalesforceConnect(): void {
  window.location.href = `${oauthBase()}/auth/salesforce`;
}
