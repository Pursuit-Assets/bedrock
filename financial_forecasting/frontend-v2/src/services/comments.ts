import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface CommentAuthor {
  id: string | null;
  email: string | null;
  display_name: string | null;
}

export interface Comment {
  id: string;
  entity_type: string;
  entity_id: string;
  author_id: string | null;
  author: CommentAuthor | null;
  content: string;
  created_at: string | null;
  updated_at: string | null;
}

interface CommentsResponse {
  success: boolean;
  data: Comment[];
}

interface CommentResponse {
  success: boolean;
  data: Comment;
}

function key(entityType: string, entityId: string) {
  return ["comments", entityType, entityId] as const;
}

export function useComments(entityType: string, entityId: string | undefined) {
  return useQuery({
    queryKey: entityId ? key(entityType, entityId) : ["comments", entityType, "none"],
    queryFn: async (): Promise<Comment[]> => {
      const { data } = await api.get<CommentsResponse>(
        `/api/comments/${entityType}/${entityId}`,
      );
      return data.data ?? [];
    },
    enabled: !!entityId,
    staleTime: 30_000,
  });
}

export function useCreateComment(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post<CommentResponse>(
        `/api/comments/${entityType}/${entityId}`,
        { content },
      );
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
  });
}

export function useUpdateComment(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, content }: { commentId: string; content: string }) => {
      const { data } = await api.put<CommentResponse>(
        `/api/comments/${commentId}`,
        { content },
      );
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
  });
}

export function useDeleteComment(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/comments/${commentId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
  });
}
