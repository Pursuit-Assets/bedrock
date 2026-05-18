import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

interface PermissionData {
  user_id: string;
  email: string | null;
  name: string | null;
  sf_user_id: string | null;
  profile_name: string | null;
  is_active: boolean;
  org_user_id: string | null;
  permissions: Record<string, boolean>;
}

interface PermissionsResponse {
  success: boolean;
  data: PermissionData;
}

async function fetchPermissions(): Promise<PermissionData> {
  const { data } = await api.get<PermissionsResponse>("/api/permissions/me");
  return data.data;
}

export function usePermissions() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: fetchPermissions,
    staleTime: 5 * 60_000,
  });
}

export function usePerm(key: string): boolean {
  const { data } = usePermissions();
  // Default true while loading so the UI doesn't flash read-only state
  return data?.permissions?.[key] ?? true;
}

/**
 * Strict per-permission hook for launch-dark gates (currently
 * pebble_access).
 *
 * Unlike usePerm, this defaults to FALSE while loading — required so the
 * Pebble sidebar entry / page does not flash visible to non-JP users
 * during the brief window between mount and /api/permissions/me returning.
 *
 * Use this anywhere a feature is restricted and a brief "flash of visible
 * content" would be a real product issue.
 */
export function useStrictPerm(key: string): boolean {
  const { data, isLoading } = usePermissions();
  if (isLoading) return false;
  return data?.permissions?.[key] === true;
}

/** Convenience alias for the master Pebble launch-dark gate. */
export function usePebbleAccess(): boolean {
  return useStrictPerm("pebble_access");
}
