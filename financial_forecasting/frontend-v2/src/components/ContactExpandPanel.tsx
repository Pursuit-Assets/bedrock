import { useMemo } from "react";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { useContactTasks, useCreateGenericTask } from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
import type { SfTask } from "@/types/salesforce";

export const CONTACT_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

export function ContactExpandPanel({ contactId }: { contactId: string }) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <ContactTasks contactId={contactId} />,
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ contactId }}
              emptyMessage="No emails, meetings, or notes recorded for this contact yet."
            />
          ),
        },
      ]}
    />
  );
}

/**
 * Editable task list for a contact. Sourced from
 * `/api/salesforce/contacts/{id}/tasks` (Task.WhoId = contact). Creation
 * sets WhoId = contactId (no WhatId — parent record is set later by the
 * user if/when this task is reassigned to an opp or account).
 */
function ContactTasks({ contactId }: { contactId: string }) {
  const { data: tasks = [], isLoading } = useContactTasks(contactId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateGenericTask();

  // Surface the parent record (opp / account / etc.) on each row so the
  // user can see at a glance whether this is a "Call about Acme proposal"
  // vs. "Birthday card" — different intents, same WhoId.
  const contextResolver = (t: SfTask) => t.WhatName ?? null;

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task linked to this contact — Enter to create"
      emptyMessage="No tasks linked to this contact."
      ownerOptions={ownerOptions}
      onCreate={async ({ subject, ownerId, activityDate }) => {
        await createTask.mutateAsync({
          Subject: subject,
          WhoId: contactId,
          OwnerId: ownerId ?? undefined,
          ActivityDate: activityDate ?? undefined,
        });
      }}
      contextResolver={contextResolver}
    />
  );
}
