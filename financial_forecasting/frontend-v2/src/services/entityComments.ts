import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export type EntityCommentType = "account" | "opportunity" | "contact";

export interface EntityComment {
  id: string;
  entity_type: EntityCommentType;
  entity_id: string;
  author_id: string | null;
  author_email: string | null;
  content: string;
  created_at: string | null;
  updated_at: string | null;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function key(entityType: string, entityId: string) {
  return ["entity-comments", entityType, entityId] as const;
}

export function useEntityComments(entityType: EntityCommentType, entityId: string | undefined) {
  return useQuery({
    queryKey: entityId ? key(entityType, entityId) : ["entity-comments", entityType, "none"],
    queryFn: async (): Promise<EntityComment[]> => {
      const { data } = await api.get<ApiResponse<EntityComment[]>>("/api/entity-comments", {
        params: { entity_type: entityType, entity_id: entityId },
      });
      return data.data ?? [];
    },
    enabled: !!entityId,
    staleTime: 30_000,
  });
}

export function useCreateEntityComment(entityType: EntityCommentType, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post<ApiResponse<EntityComment>>("/api/entity-comments", {
        entity_type: entityType,
        entity_id: entityId,
        content,
      });
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
    onError: () => toast.error("Failed to post comment"),
  });
}

export function useUpdateEntityComment(entityType: EntityCommentType, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, content }: { commentId: string; content: string }) => {
      const { data } = await api.patch<ApiResponse<EntityComment>>(
        `/api/entity-comments/${commentId}`,
        { content },
      );
      return data.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
    onError: () => toast.error("Failed to update comment"),
  });
}

export function useDeleteEntityComment(entityType: EntityCommentType, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/entity-comments/${commentId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key(entityType, entityId) }),
    onError: () => toast.error("Failed to delete comment"),
  });
}
