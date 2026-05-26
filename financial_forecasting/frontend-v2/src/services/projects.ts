import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface BedrockProject {
  id: string;
  name: string;
  description: string;
  owner_email: string | null;
  opportunity_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  owner_ids: string[];
  deadline: string | null;
  startDate: string | null;
  description: string | null;
  updates: string | null;
  links: string[];
  dependsOn: string[];
  sort_order: number;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  status: string;
  priority: string;
  owner: string | null;
  owner_ids: string[];
  due_date: string | null;
  description: string;
  sourceLinks: string[];
  tasks: ProjectTask[];
}

export interface ProjectWorkstream {
  id: string;
  name: string;
  description: string;
  milestones: ProjectMilestone[];
}

export interface ProjectDetail extends BedrockProject {
  workstreams: ProjectWorkstream[];
  contributors: { user_email: string; role: string }[];
}

interface ProjectsResponse {
  success: boolean;
  data: BedrockProject[];
}

interface ProjectDetailResponse {
  success: boolean;
  data: ProjectDetail;
}

async function fetchProjects(): Promise<BedrockProject[]> {
  const { data } = await api.get<ProjectsResponse>("/api/projects");
  return data.data ?? [];
}

async function fetchProjectDetail(id: string): Promise<ProjectDetail> {
  const { data } = await api.get<ProjectDetailResponse>(`/api/projects/${id}`);
  return data.data;
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    staleTime: 60_000,
  });
}

export function useProjectDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["project-detail", id],
    queryFn: () => fetchProjectDetail(id!),
    enabled: !!id,
    staleTime: 60_000,
  });
}

// ── Mutation hooks ────────────────────────────────────────────────────────────

export interface ActiveUser {
  id: string;
  email: string;
  display_name: string;
  sf_user_id: string | null;
  is_in_sf: boolean;
}

export interface TaskPatch {
  title?: string;
  status?: string;
  owner?: string;
  owner_ids?: string[];
  deadline?: string | null;
  start_date?: string | null;
  description?: string;
  sort_order?: number;
}

export function useActiveUsers() {
  return useQuery({
    queryKey: ["active-users"],
    queryFn: async () => {
      const { data } = await api.get<{ success: boolean; data: ActiveUser[] }>("/api/users/active");
      return data.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export function useCreateTask(projectId: string) {
  const qc = useQueryClient();
  const key = ["project-detail", projectId];
  return useMutation({
    mutationFn: async ({ milestoneId, title }: { milestoneId: string; title: string }) => {
      await api.post(`/api/milestones/${milestoneId}/tasks`, { title });
    },
    onMutate: async ({ milestoneId, title }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ProjectDetail>(key);
      const tempId = `temp-${Date.now()}`;
      qc.setQueryData<ProjectDetail | undefined>(key, (cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          workstreams: cur.workstreams.map((ws) => ({
            ...ws,
            milestones: ws.milestones.map((ms) =>
              ms.id !== milestoneId
                ? ms
                : {
                    ...ms,
                    tasks: [
                      ...ms.tasks,
                      {
                        id: tempId,
                        title,
                        status: "Not Started",
                        owner: null,
                        owner_ids: [],
                        deadline: null,
                        startDate: null,
                        description: null,
                        updates: null,
                        links: [],
                        dependsOn: [],
                        sort_order: ms.tasks.length,
                      } as ProjectTask,
                    ],
                  },
            ),
          })),
        };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, patch }: { taskId: string; patch: TaskPatch }) => {
      await api.put(`/api/project-tasks/${taskId}`, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-detail", projectId] }),
  });
}

export function useDeleteTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      await api.delete(`/api/project-tasks/${taskId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-detail", projectId] }),
  });
}

export function useCreateMilestone(projectId: string) {
  const qc = useQueryClient();
  const key = ["project-detail", projectId];
  return useMutation({
    mutationFn: async ({ workstreamId, title }: { workstreamId: string; title: string }) => {
      await api.post(`/api/workstreams/${workstreamId}/milestones`, { title });
    },
    onMutate: async ({ workstreamId, title }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ProjectDetail>(key);
      const tempId = `temp-${Date.now()}`;
      qc.setQueryData<ProjectDetail | undefined>(key, (cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          workstreams: cur.workstreams.map((ws) =>
            ws.id !== workstreamId
              ? ws
              : {
                  ...ws,
                  milestones: [
                    ...ws.milestones,
                    {
                      id: tempId,
                      title,
                      status: "On Track",
                      priority: "",
                      owner: null,
                      owner_ids: [],
                      due_date: null,
                      description: "",
                      sourceLinks: [],
                      tasks: [],
                    } as ProjectMilestone,
                  ],
                },
          ),
        };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useCreateWorkstream(projectId: string) {
  const qc = useQueryClient();
  const key = ["project-detail", projectId];
  return useMutation({
    mutationFn: async (name: string) => {
      await api.post(`/api/projects/${projectId}/workstreams`, { name });
    },
    onMutate: async (name) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ProjectDetail>(key);
      const tempId = `temp-${Date.now()}`;
      qc.setQueryData<ProjectDetail | undefined>(key, (cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          workstreams: [
            ...cur.workstreams,
            {
              id: tempId,
              name,
              description: "",
              milestones: [],
            } as ProjectWorkstream,
          ],
        };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Fan-out fetch — every project's full tree, in parallel. Used by the
 * global Tasks page to flatten tasks across all projects.
 */
export function useAllProjectDetails() {
  const list = useProjects();
  const ids = (list.data ?? []).map((p) => p.id);
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["project-detail", id],
      queryFn: () => fetchProjectDetail(id),
      staleTime: 60_000,
      enabled: !!id,
    })),
  });
  return {
    isLoading: list.isLoading || queries.some((q) => q.isLoading),
    isError: list.isError || queries.some((q) => q.isError),
    error: list.error ?? queries.find((q) => q.error)?.error ?? null,
    projects: list.data ?? [],
    details: queries.map((q) => q.data).filter((d): d is ProjectDetail => !!d),
  };
}

export function useUpdateMilestone(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ milestoneId, patch }: { milestoneId: string; patch: { due_date?: string | null; status?: string; title?: string; description?: string; priority?: string } }) => {
      await api.put(`/api/milestones/${milestoneId}`, patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["project-detail", projectId] }); },
  });
}

export function useDeleteMilestone(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (milestoneId: string) => {
      await api.delete(`/api/milestones/${milestoneId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-detail", projectId] }),
  });
}

export function useDeleteWorkstream(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workstreamId: string) => {
      await api.delete(`/api/workstreams/${workstreamId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-detail", projectId] }),
  });
}

/** Workstream PATCH — currently only `name` + `description` + `sort_order`
 *  are mutable per the backend `WorkstreamUpdate` model. */
export function useUpdateWorkstream(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      workstreamId,
      patch,
    }: {
      workstreamId: string;
      patch: { name?: string; description?: string; sort_order?: number };
    }) => {
      await api.put(`/api/workstreams/${workstreamId}`, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-detail", projectId] }),
  });
}

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { name?: string; description?: string; opportunity_id?: string }) => {
      await api.put(`/api/projects/${projectId}`, patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-detail", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description?: string; opportunity_id?: string }) => {
      const { data } = await api.post<{ success: boolean; data: BedrockProject }>(
        "/api/projects",
        { name: body.name, description: body.description ?? "", opportunity_id: body.opportunity_id },
      );
      return data.data;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects"] }); },
  });
}

export function useLinkProjectToOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, opportunityId }: { projectId: string; opportunityId: string }) => {
      await api.put(`/api/projects/${projectId}`, { opportunity_id: opportunityId });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects"] }); },
  });
}
