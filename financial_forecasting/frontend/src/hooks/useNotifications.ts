import { useMemo, useCallback, useState } from 'react';
import { useQuery } from 'react-query';
import { parseISO, differenceInDays, startOfDay } from 'date-fns';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { OPEN_STAGES } from '../types/salesforce';
import type { InboxTask } from '../components/TaskInbox';
import type {
  CrmNotification,
  NotificationSeverity,
  NotificationType,
  NotificationState,
  OwnershipChangeRecord,
} from '../types/notifications';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'bedrock-notifications-state';
const MAX_NOTIFICATIONS = 20;
const TASK_ASSIGNMENT_WINDOW_DAYS = 7;
const CLOSE_DATE_WARN_DAYS = 14;
const CLOSE_DATE_URGENT_DAYS = 7;

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function readState(): NotificationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate from old lastSeenTimestamp format
      if (parsed && Array.isArray(parsed.readIds)) return parsed as NotificationState;
    }
  } catch { /* ignore corrupt data */ }
  return { readIds: [] };
}

function writeState(state: NotificationState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage full — degrade gracefully */ }
}

// ---------------------------------------------------------------------------
// Ownership matching
// ---------------------------------------------------------------------------

function matchOwnership(
  record: OwnershipChangeRecord,
  sfUserId: string | null,
  sfUserName: string | null,
): 'gained' | 'lost' | null {
  // Try ID match first (when OldValue/NewValue are Salesforce IDs)
  if (sfUserId) {
    if (record.NewValue === sfUserId) return 'gained';
    if (record.OldValue === sfUserId) return 'lost';
  }
  // Fall back to resolved name match
  if (sfUserName) {
    if (record.NewOwnerName === sfUserName) return 'gained';
    if (record.OldOwnerName === sfUserName) return 'lost';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Currency formatter (compact)
// ---------------------------------------------------------------------------

function fmtAmount(amount: number | null): string {
  if (!amount) return '';
  if (amount >= 1_000_000) return ` ($${(amount / 1_000_000).toFixed(1)}M)`;
  if (amount >= 1_000) return ` ($${(amount / 1_000).toFixed(0)}K)`;
  return ` ($${amount.toLocaleString()})`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseNotificationsResult {
  notifications: CrmNotification[];
  unreadCount: number;
  badgeColor: 'error' | 'warning' | 'default';
  markOneRead: (id: string) => void;
  markAllRead: () => void;
  loading: boolean;
}

export function useNotifications(
  tasks: InboxTask[],
  sfUserId: string | null | undefined,
  sfUserName: string | null | undefined,
): UseNotificationsResult {
  const [notifState, setNotifState] = useState<NotificationState>(readState);
  const { isAdmin } = usePermissions();

  // ---- Queries (dedup with existing caches) ----------------------------

  const { data: oppsData, isLoading: oppsLoading } = useQuery(
    'opportunities',
    async () => {
      const response = await apiService.getOpportunities();
      return response.data;
    },
    { staleTime: 5 * 60 * 1000 },
  );

  const { data: ownershipData, isLoading: ownershipLoading } = useQuery(
    ['ownership-history', 7],
    async () => {
      const response = await apiService.getOwnershipHistory(7);
      return (response.data || []) as OwnershipChangeRecord[];
    },
    { staleTime: 5 * 60 * 1000 },
  );

  const { data: unlockRequests } = useQuery(
    'pending-unlock-requests',
    async () => {
      const res = await apiService.getUnlockRequests({ status: 'pending' });
      return res.data?.data || [];
    },
    { enabled: isAdmin, staleTime: 5 * 60_000 },
  );

  // ---- Compute notifications -------------------------------------------

  const notifications = useMemo(() => {
    const uid = sfUserId ?? null;
    const uname = sfUserName ?? null;
    if (!uid) return []; // SF not connected — nothing to show

    const now = startOfDay(new Date());
    const readSet = new Set(notifState.readIds);
    const items: CrmNotification[] = [];

    // Extract opportunities array from potentially wrapped response
    const opportunities: any[] = Array.isArray(oppsData)
      ? oppsData
      : ((oppsData as any)?.opportunities || (oppsData as any)?.data || []);

    // -- 1. Task assignments (recent, assigned by someone else) ----------

    for (const task of tasks) {
      if (task.OwnerId !== uid) continue; // not my task
      if (!task.CreatedById || task.CreatedById === uid) continue; // self-created
      if (!task.CreatedDate) continue;

      const created = parseISO(task.CreatedDate);
      const ageDays = differenceInDays(now, startOfDay(created));
      if (ageDays > TASK_ASSIGNMENT_WINDOW_DAYS) continue;

      const id = `task-assignment:${task.Id}`;
      const assigner = task.CreatedByName || 'Someone';
      items.push({
        id,
        type: 'task-assignment',
        severity: 'info',
        title: `${assigner} assigned you a task`,
        subtitle: task.Subject,
        timestamp: task.CreatedDate,
        taskId: task.Id,
        whatId: task.WhatId,
        isNew: !readSet.has(id),
      });
    }

    // -- 2. Ownership changes (gained / lost) ----------------------------

    const ownershipRecords = ownershipData || [];
    for (const record of ownershipRecords) {
      const direction = matchOwnership(record, uid, uname);
      if (!direction) continue;

      const amountStr = fmtAmount(record.Amount);
      let severity: NotificationSeverity = 'info';
      let title: string;
      let subtitle: string;

      if (direction === 'gained') {
        const changer = record.ChangedByName || 'Someone';
        title = `${changer} assigned you an opportunity`;
        subtitle = `${record.OpportunityName}${amountStr}`;
      } else {
        severity = 'warning';
        const changer = record.ChangedByName || 'Someone';
        title = `${changer} reassigned your opportunity`;
        subtitle = `${record.OpportunityName} → ${record.NewOwnerName}${amountStr}`;
      }

      const id = `ownership-${direction}:${record.OpportunityId}:${record.CreatedDate}`;
      items.push({
        id,
        type: direction === 'gained' ? 'ownership-gained' : 'ownership-lost',
        severity,
        title,
        subtitle,
        timestamp: record.CreatedDate,
        opportunityId: record.OpportunityId,
        isNew: !readSet.has(id),
      });
    }

    // -- 3. Close date warnings ------------------------------------------

    const openStagesSet = new Set<string>(OPEN_STAGES as readonly string[]);
    for (const opp of opportunities) {
      if (opp.OwnerId !== uid) continue;
      if (!opp.CloseDate) continue;
      if (!openStagesSet.has(opp.StageName)) continue;

      const closeDate = parseISO(opp.CloseDate);
      const daysUntilClose = differenceInDays(closeDate, now);
      if (daysUntilClose < 1 || daysUntilClose > CLOSE_DATE_WARN_DAYS) continue;

      const id = `close-date-warning:${opp.Id}`;
      const amountStr = fmtAmount(opp.Amount);
      const severity: NotificationSeverity =
        daysUntilClose <= CLOSE_DATE_URGENT_DAYS ? 'error' : 'warning';

      items.push({
        id,
        type: 'close-date-warning',
        severity,
        title: `${opp.Name} closes in ${daysUntilClose} day${daysUntilClose !== 1 ? 's' : ''}`,
        subtitle: `${opp.StageName}${amountStr}`,
        timestamp: opp.CloseDate,
        opportunityId: opp.Id,
        isNew: !readSet.has(id),
      });
    }

    // -- 4. Permission unlock requests (admin only) ---------------------

    const permissionNotifications: CrmNotification[] = (unlockRequests || []).map((req: any) => ({
      id: `permission-request:${req.id}`,
      type: 'permission-request' as NotificationType,
      severity: 'info' as NotificationSeverity,
      title: `${req.requester_email} requested unlock`,
      subtitle: `${req.permission_key}`,
      timestamp: req.created_at,
      isNew: !readSet.has(`permission-request:${req.id}`),
    }));
    items.push(...permissionNotifications);

    // -- Dedupe by id (SF can emit multiple OpportunityFieldHistory rows
    //    for the same opp+timestamp after a bulk reassignment; keep first) --
    const seen = new Set<string>();
    const deduped = items.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });

    // -- Sort by timestamp descending, limit ----------------------------
    deduped.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // -- Prune stale readIds (keep only IDs that exist in current set) --
    // IMPORTANT: only prune once data has actually loaded, otherwise the
    // first render (while queries are in-flight) sees an empty id set and
    // wipes every readId from localStorage, resurrecting every notification
    // as "new" on refresh.
    const dataReady = Boolean(oppsData) && Boolean(ownershipData);
    if (dataReady) {
      const currentIds = new Set(deduped.map((i) => i.id));
      const pruned = notifState.readIds.filter((rid) => currentIds.has(rid));
      if (pruned.length !== notifState.readIds.length) {
        const next = { readIds: pruned };
        // Defer to avoid setState during render
        queueMicrotask(() => { setNotifState(next); writeState(next); });
      }
    }

    return deduped.slice(0, MAX_NOTIFICATIONS);
  }, [tasks, oppsData, ownershipData, unlockRequests, sfUserId, sfUserName, notifState]);

  // ---- Badge ----------------------------------------------------------

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.isNew).length,
    [notifications],
  );

  const badgeColor = useMemo<'error' | 'warning' | 'default'>(() => {
    const unread = notifications.filter((n) => n.isNew);
    if (unread.some((n) => n.severity === 'error')) return 'error';
    if (unread.some((n) => n.severity === 'warning')) return 'warning';
    return 'default';
  }, [notifications]);

  // ---- Actions --------------------------------------------------------

  const markOneRead = useCallback((id: string) => {
    setNotifState((prev) => {
      if (prev.readIds.includes(id)) return prev;
      const next = { readIds: [...prev.readIds, id] };
      writeState(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifState((prev) => {
      const allIds = notifications.map((n) => n.id);
      const merged = new Set([...prev.readIds, ...allIds]);
      const next = { readIds: Array.from(merged) };
      writeState(next);
      return next;
    });
  }, [notifications]);

  return {
    notifications,
    unreadCount,
    badgeColor,
    markOneRead,
    markAllRead,
    loading: oppsLoading || ownershipLoading,
  };
}
