import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { apiService } from '../../services/api';
import { AIJI_PROJECT_ID } from './constants';
import type { Workstream, ProjectMutations, ProjectContributor } from './types';

export function useProjectData(projectId: string | null = AIJI_PROJECT_ID) {
  const queryClient = useQueryClient();
  const QUERY_KEY = ['project', projectId];

  const { data: projectData, isLoading, error } = useQuery(
    QUERY_KEY,
    async () => {
      if (!projectId) return null;
      const res = await apiService.getProject(projectId);
      return res.data?.data || res.data;
    },
    { staleTime: 30_000, enabled: !!projectId }
  );

  const workstreams: Workstream[] = projectData?.workstreams || [];
  const projectName: string = projectData?.name || '';
  const ownerEmail: string | null = projectData?.owner_email || null;
  const createdBy: string | null = projectData?.created_by || null;
  const contributors: ProjectContributor[] = projectData?.contributors || [];

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries(QUERY_KEY);
  }, [queryClient, projectId]);

  const updateTaskMutation = useMutation(
    ({ taskId, data }: { taskId: string; data: Record<string, any> }) =>
      apiService.updateProjectTask(taskId, data),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to update task'); } }
  );

  const updateMilestoneMutation = useMutation(
    ({ milestoneId, data }: { milestoneId: string; data: Record<string, any> }) =>
      apiService.updateMilestone(milestoneId, data),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to update milestone'); } }
  );

  const addTaskMutation = useMutation(
    ({ milestoneId, title }: { milestoneId: string; title: string }) =>
      apiService.createProjectTask(milestoneId, { title }),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to add task'); } }
  );

  const addMilestoneMutation = useMutation(
    ({ workstreamId, title }: { workstreamId: string; title: string }) =>
      apiService.createMilestone(workstreamId, { title }),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to add milestone'); } }
  );

  const deleteTaskMutation = useMutation(
    (taskId: string) => apiService.deleteProjectTask(taskId),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to delete task'); } }
  );

  const deleteMilestoneMutation = useMutation(
    (milestoneId: string) => apiService.deleteMilestone(milestoneId),
    { onSuccess: invalidate, onError: () => { toast.error('Failed to delete milestone'); } }
  );

  const mutations: ProjectMutations = {
    updateTaskStatus: (taskId, status) =>
      updateTaskMutation.mutate({ taskId, data: { status } }),
    updateTaskDates: (taskId, startDate, deadline) =>
      updateTaskMutation.mutate({ taskId, data: { start_date: startDate, deadline } }),
    updateTask: (taskId, data) =>
      updateTaskMutation.mutate({ taskId, data }),
    updateMilestoneStatus: (milestoneId, status) =>
      updateMilestoneMutation.mutate({ milestoneId, data: { status } }),
    updateMilestone: (milestoneId, data) =>
      updateMilestoneMutation.mutate({ milestoneId, data }),
    addTask: (milestoneId, title) =>
      addTaskMutation.mutate({ milestoneId, title }),
    addMilestone: (workstreamId, title) =>
      addMilestoneMutation.mutate({ workstreamId, title }),
    deleteTask: (taskId) =>
      deleteTaskMutation.mutate(taskId),
    deleteMilestone: (milestoneId) =>
      deleteMilestoneMutation.mutate(milestoneId),
  };

  return { workstreams, projectName, ownerEmail, createdBy, contributors, isLoading, error, mutations, invalidate };
}
