import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type JobsTaskParentType = "opportunity" | "prospect" | "account";

export type JobsTaskStatus =
  | "Not Started"
  | "In Progress"
  | "Completed"
  | "Blocked"
  | "On Hold";

export interface JobsTask {
  id: string;
  parent_type: JobsTaskParentType;
  parent_id: string;
  title: string;
  status: JobsTaskStatus;
  owner: string;
  owner_ids: string[];
  deadline: string | null;
  start_date: string | null;
  description: string;
  links: string[];
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateJobsTaskInput {
  title: string;
  owner_ids?: string[];
  deadline?: string | null;
  start_date?: string | null;
  description?: string;
}

export interface UpdateJobsTaskPatch {
  title?: string;
  status?: JobsTaskStatus;
  owner?: string;
  owner_ids?: string[];
  deadline?: string | null;
  start_date?: string | null;
  description?: string;
  links?: string[];
  sort_order?: number;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function key(parentType: string, parentId: string) {
  return ["jobs-tasks", parentType, parentId] as const;
}

export function useJobsTasks(parentType: JobsTaskParentType, parentId: string | undefined) {
  return useQuery({
    queryKey: parentId ? key(parentType, parentId) : ["jobs-tasks", parentType, "none"],
    queryFn: async (): Promise<JobsTask[]> => {
      const { data } = await api.get<ApiResponse<JobsTask[]>>("/api/jobs/jobs-tasks", {
        params: { parent_type: parentType, parent_id: parentId },
      });
      return data.data ?? [];
    },
    enabled: !!parentId,
    staleTime: 30_000,
  });
}

export function useCreateJobsTask(parentType: JobsTaskParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateJobsTaskInput) => {
      const { data } = await api.post<ApiResponse<JobsTask>>("/api/jobs/jobs-tasks", {
        parent_type: parentType,
        parent_id: parentId,
        ...input,
      });
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to create task"),
  });
}

export function useUpdateJobsTask(parentType: JobsTaskParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, patch }: { taskId: string; patch: UpdateJobsTaskPatch }) => {
      const { data } = await api.patch<ApiResponse<JobsTask>>(
        `/api/jobs/jobs-tasks/${taskId}`,
        patch,
      );
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to update task"),
  });
}

export function useDeleteJobsTask(parentType: JobsTaskParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      await api.delete(`/api/jobs/jobs-tasks/${taskId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to delete task"),
  });
}

// ── Command-center: all tasks across every parent ──────────────────────────────

export interface JobsTaskEnriched extends JobsTask {
  parent_label: string;
  parent_sublabel: string | null;
  parent_stage: string | null;
  owner_names: string[];
}

const ALL_TASKS_KEY = ["jobs-tasks-all"] as const;

export function useAllJobsTasks(includeCompleted = false) {
  return useQuery({
    queryKey: [...ALL_TASKS_KEY, includeCompleted],
    queryFn: async (): Promise<JobsTaskEnriched[]> => {
      const { data } = await api.get<ApiResponse<JobsTaskEnriched[]>>("/api/jobs/tasks/all", {
        params: { include_completed: includeCompleted },
      });
      return data.data ?? [];
    },
    staleTime: 30_000,
  });
}

/** Update any task by id (parent not known on the home board). Invalidates the
 *  all-tasks list and the per-parent caches. */
export function useUpdateTaskById() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, patch }: { taskId: string; patch: UpdateJobsTaskPatch }) => {
      const { data } = await api.patch<ApiResponse<JobsTask>>(`/api/jobs/jobs-tasks/${taskId}`, patch);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      qc.invalidateQueries({ queryKey: ["jobs-tasks"] });
    },
    onError: () => toast.error("Failed to update task"),
  });
}

/** Create a task against an explicit parent (account/opp picked on the board). */
export function useCreateTaskForParent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: CreateJobsTaskInput & { parent_type: JobsTaskParentType; parent_id: string },
    ) => {
      const { data } = await api.post<ApiResponse<JobsTask>>("/api/jobs/jobs-tasks", input);
      return data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      qc.invalidateQueries({ queryKey: ["jobs-tasks"] });
    },
    onError: () => toast.error("Failed to create task"),
  });
}

export function useDeleteTaskById() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => { await api.delete(`/api/jobs/jobs-tasks/${taskId}`); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      qc.invalidateQueries({ queryKey: ["jobs-tasks"] });
    },
    onError: () => toast.error("Failed to delete task"),
  });
}
