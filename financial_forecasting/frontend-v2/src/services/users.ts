import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { SfUser } from "@/types/salesforce";

async function fetchUsers(): Promise<SfUser[]> {
  // Backend (main.py:1299) raises 500 when SF service is not connected
  // instead of returning []. Tolerate that here so the UI degrades to an
  // empty owner picker rather than red retry-storms in the console.
  try {
    const { data } = await api.get<SfUser[]>("/api/salesforce/users");
    return data ?? [];
  } catch {
    return [];
  }
}

export function useUsers() {
  return useQuery({
    queryKey: ["sf-users"],
    queryFn: fetchUsers,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Active users only, sorted by name. Used by every owner picker.
 */
export function useActiveUsers() {
  const q = useUsers();
  const active = (q.data ?? [])
    .filter((u) => u.IsActive)
    .sort((a, b) => a.Name.localeCompare(b.Name));
  return { ...q, data: active };
}
