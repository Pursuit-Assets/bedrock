import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> { success: boolean; data: T }

export type RoleStatus = "open" | "filled" | "cancelled";

export interface Role {
  id: string;
  opportunity_id: string;
  title: string;
  approx_salary: number | null;
  employment_type: string | null;
  start_date: string | null;
  status: RoleStatus;
  filled_by_user_id: number | null;
  employment_record_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoleCreateBody {
  title: string;
  approx_salary?: number;
  employment_type?: string;
  start_date?: string;
  notes?: string;
}

export type RolePatchBody = Partial<{
  title: string;
  approx_salary: number | null;
  employment_type: string | null;
  start_date: string | null;
  status: RoleStatus;
  notes: string | null;
}>;

export interface RoleHireBody {
  user_id: number;
  salary?: number;
  start_date?: string;
  employment_type?: string;
}

export interface BuilderActivityRow {
  job_application_id: number;
  builder: string;
  company_name: string | null;
  role_title: string | null;
  stage: string | null;
  jobs_role_id: string | null;
  date_applied: string | null;
}

export interface BuilderActivity {
  rows: BuilderActivityRow[];
  summary: { applied: number; interview: number; accepted: number };
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useOppRoles(oppId: string | null) {
  return useQuery<Role[]>({
    queryKey: ["jobs", "opp-roles", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<Role[]>>(`/api/jobs/opportunities/${oppId}/roles`);
      return data.data;
    },
    enabled: Boolean(oppId),
    staleTime: 15_000,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ oppId, ...body }: { oppId: string } & RoleCreateBody) => {
      const { data } = await api.post<ApiResponse<Role>>(
        `/api/jobs/opportunities/${oppId}/roles`,
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Role added");
    },
    onError: () => toast.error("Failed to add role"),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId, ...body }: { roleId: string; oppId?: string } & RolePatchBody) => {
      const { data } = await api.patch<ApiResponse<Role>>(`/api/jobs/roles/${roleId}`, body);
      return data.data;
    },
    onSuccess: (updated, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId ?? updated.opportunity_id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Role updated");
    },
    onError: () => toast.error("Update failed"),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId }: { roleId: string; oppId?: string }) => {
      const { data } = await api.delete<ApiResponse<{ deleted: boolean }>>(`/api/jobs/roles/${roleId}`);
      return data.data;
    },
    onSuccess: (_d, vars) => {
      if (vars.oppId) qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Role removed");
    },
    onError: () => toast.error("Delete failed"),
  });
}

export function useHireRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, oppId: _oppId, ...body }: { roleId: string; oppId?: string } & RoleHireBody) => {
      const { data } = await api.post<ApiResponse<{ role: Role; employment_record_id: number }>>(
        `/api/jobs/roles/${roleId}/hire`,
        body,
      );
      return data.data;
    },
    onSuccess: (result, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "opp-roles", vars.oppId ?? result.role.opportunity_id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Builder hired");
    },
    onError: () => toast.error("Hire failed"),
  });
}

export function useOppBuilderActivity(oppId: string | null) {
  return useQuery<BuilderActivity>({
    queryKey: ["jobs", "opp-builder-activity", oppId],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<BuilderActivity>>(
        `/api/jobs/opportunities/${oppId}/builder-activity`,
      );
      return data.data;
    },
    enabled: Boolean(oppId),
    staleTime: 15_000,
  });
}
