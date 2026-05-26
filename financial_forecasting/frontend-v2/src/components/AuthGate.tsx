import { Navigate, useLocation } from "react-router-dom";
import { useEffect, useRef, type ReactNode } from "react";
import { useIsRestoring, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/services/auth";
import { api } from "@/lib/api";
import type { SfAccount } from "@/types/salesforce";

/**
 * Wrap routes that require an authenticated session. If the user isn't
 * logged in, redirect to /login.
 *
 * Three render states matter here:
 * 1. **Restoring** (`useIsRestoring()` true): the persistent query cache
 *    is hydrating from localStorage. Queries are paused, so `isLoading`
 *    can be false even though no fetch has happened yet. Treat this as
 *    "still loading".
 * 2. **Loading** (`isPending && fetchStatus === 'fetching'`): the
 *    `/auth/me` request is in flight. Show a loading shell.
 * 3. **Loaded**: data is null → redirect; data is the user → render.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const isRestoring = useIsRestoring();
  const { data: user, isPending, isFetched } = useCurrentUser();
  const location = useLocation();
  const qc = useQueryClient();
  const prefetchedRef = useRef(false);

  // Fire parallel prefetches once per session the moment we know the user
  // is authenticated. This warms the cache before the user navigates to
  // Pipeline, Accounts, or Awards, making those pages feel instant.
  useEffect(() => {
    if (!user || prefetchedRef.current) return;
    prefetchedRef.current = true;
    // Two-phase accounts prefetch matching the useAccounts() hook —
    // active-only resolves fast (~1.5 s) so the first page paint reads
    // from cache; the full 20 k set lands in the background.
    void qc.prefetchQuery({
      queryKey: ["accounts", "active-only"],
      queryFn: async () => {
        const { data } = await api.get<SfAccount[]>("/api/salesforce/accounts?fields=light&active_only=true");
        return data;
      },
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: ["accounts"],
      queryFn: async () => {
        const { data } = await api.get<SfAccount[]>("/api/salesforce/accounts?fields=light");
        return data;
      },
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: ["opportunities", {}],
      queryFn: async () => {
        const { data } = await api.get("/api/salesforce/opportunities");
        return data;
      },
      staleTime: 60_000,
    });
    // Payments share enough surface with Pipeline (column overlap, expand
    // panel) that warming this in parallel hides the cold-load on the
    // first /payments navigation without much extra cost.
    void qc.prefetchQuery({
      queryKey: ["payments"],
      queryFn: async () => {
        try {
          const { data } = await api.get("/api/salesforce/payments?limit=2000");
          return data ?? [];
        } catch {
          return [];
        }
      },
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: ["sf-users"],
      queryFn: async () => {
        try {
          const { data } = await api.get("/api/salesforce/users");
          return data ?? [];
        } catch {
          return [];
        }
      },
      staleTime: 300_000,
    });
  }, [user, qc]);

  // Until we have a definitive answer, render a placeholder. Don't
  // redirect — that would bounce a logged-in user to /login during the
  // ~50ms persister-rehydration window.
  if (isRestoring || (isPending && !isFetched)) {
    return (
      <div className="grid h-screen place-items-center bg-bg text-[13px] text-ink-3">
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to={`/login${
          location.pathname && location.pathname !== "/"
            ? `?next=${encodeURIComponent(location.pathname)}`
            : ""
        }`}
        replace
      />
    );
  }

  return <>{children}</>;
}
