import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type JobsCommentParentType = "opportunity" | "prospect" | "account";

export interface JobsComment {
  id: string;
  parent_type: JobsCommentParentType;
  parent_id: string;
  author_id: string | null;
  author_email: string | null;
  content: string;
  created_at: string | null;
  updated_at: string | null;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function key(parentType: string, parentId: string) {
  return ["jobs-comments", parentType, parentId] as const;
}

export function useJobsComments(parentType: JobsCommentParentType, parentId: string | undefined) {
  return useQuery({
    queryKey: parentId ? key(parentType, parentId) : ["jobs-comments", parentType, "none"],
    queryFn: async (): Promise<JobsComment[]> => {
      const { data } = await api.get<ApiResponse<JobsComment[]>>("/api/jobs/jobs-comments", {
        params: { parent_type: parentType, parent_id: parentId },
      });
      return data.data ?? [];
    },
    enabled: !!parentId,
    staleTime: 30_000,
  });
}

export function useCreateJobsComment(parentType: JobsCommentParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post<ApiResponse<JobsComment>>("/api/jobs/jobs-comments", {
        parent_type: parentType,
        parent_id: parentId,
        content,
      });
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to post comment"),
  });
}

export function useUpdateJobsComment(parentType: JobsCommentParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, content }: { commentId: string; content: string }) => {
      const { data } = await api.patch<ApiResponse<JobsComment>>(
        `/api/jobs/jobs-comments/${commentId}`,
        { content },
      );
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to update comment"),
  });
}

export function useDeleteJobsComment(parentType: JobsCommentParentType, parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/jobs/jobs-comments/${commentId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(parentType, parentId) }),
    onError: () => toast.error("Failed to delete comment"),
  });
}
