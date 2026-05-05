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
