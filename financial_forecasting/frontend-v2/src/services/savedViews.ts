/**
 * Saved filter views — backed by `bedrock.saved_view` via
 * `/api/saved-views`. Each view has an opaque JSON `filters` payload
 * the calling page (Pipeline, Accounts, Cleanup, etc.) serializes
 * its own filter shape into.
 *
 * Visibility:
 *   - Personal: caller's own saved views (scoped by their JWT email).
 *   - Global: org-wide views any user can load. Admins create them.
 *
 * The picker renders both lists side-by-side and gates the "Save
 * globally" toggle on the user's permission set.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface SavedView<F = Record<string, unknown>> {
  id: string;
  scope_key: string;
  name: string;
  /** Email of the personal owner; null when the view is global. */
  owner_email: string | null;
  is_global: boolean;
  filters: F;
  created_at: string;
  updated_at: string;
}

export function useSavedViews<F>(scopeKey: string) {
  return useQuery({
    queryKey: ["saved-views", scopeKey],
    queryFn: async (): Promise<SavedView<F>[]> => {
      const { data } = await api.get<SavedView<F>[]>(
        `/api/saved-views?scope_key=${encodeURIComponent(scopeKey)}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export interface SavedViewCreate<F = Record<string, unknown>> {
  scope_key: string;
  name: string;
  filters: F;
  is_global?: boolean;
}

export function useCreateSavedView<F>(scopeKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SavedViewCreate<F>) => {
      const { data } = await api.post<SavedView<F>>("/api/saved-views", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", scopeKey] });
    },
  });
}

export interface SavedViewUpdate<F = Record<string, unknown>> {
  id: string;
  name?: string;
  filters?: F;
  is_global?: boolean;
}

export function useUpdateSavedView<F>(scopeKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: SavedViewUpdate<F>) => {
      const { data } = await api.patch<SavedView<F>>(
        `/api/saved-views/${encodeURIComponent(id)}`,
        patch,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", scopeKey] });
    },
  });
}

export function useDeleteSavedView(scopeKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/saved-views/${encodeURIComponent(id)}`);
      return id;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", scopeKey] });
    },
  });
}
