import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type NotificationType =
  | "project_task_assigned"
  | "comment_mention"
  | "sf_task_assigned"
  | "sf_opp_owner_changed";

export type SlackDeliveryStatus =
  | "pending"
  | "sent"
  | "skipped"
  | "failed"
  | "disabled";

export interface NotificationPayload {
  title?: string | null;
  subtitle?: string | null;
  target_url?: string | null;
  /** Source identifiers for routing — see backend services/notifications.py. */
  project_id?: string | null;
  project_name?: string | null;
  workstream_name?: string | null;
  milestone_title?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  /** For comment_mention: full body (already trimmed to 280 chars). */
  comment_body?: string | null;
  /** Resolved display name of the user that triggered the notification. */
  actor_display_name?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  comment_id?: string | null;
  sf_task_id?: string | null;
  opp_id?: string | null;
}

export interface BedrockNotification {
  id: string;
  type: NotificationType;
  payload: NotificationPayload;
  actor_email: string | null;
  read_at: string | null;
  slack_status: SlackDeliveryStatus;
  created_at: string | null;
}

interface ListResponse {
  success: boolean;
  data: BedrockNotification[];
}

interface CountResponse {
  success: boolean;
  data: { count: number };
}

/** Recent notifications for the current user, newest first.
 *  Polls every 30s — light enough on a single-user GET and snappy
 *  enough that newly-assigned tasks appear on the bell without a
 *  manual reload. */
export function useNotifications(opts: { unreadOnly?: boolean } = {}) {
  return useQuery({
    queryKey: ["notifications", opts.unreadOnly ?? false],
    queryFn: async () => {
      const qs = opts.unreadOnly ? "?unread_only=true" : "";
      const { data } = await api.get<ListResponse>(`/api/notifications${qs}`);
      return data.data ?? [];
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Tiny query for the bell badge. Separate from the full list so we
 *  can poll it more aggressively without redrawing the dropdown. */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const { data } = await api.get<CountResponse>(
        "/api/notifications/unread-count",
      );
      return data.data.count;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/notifications/${id}/read`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post("/api/notifications/read-all");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
