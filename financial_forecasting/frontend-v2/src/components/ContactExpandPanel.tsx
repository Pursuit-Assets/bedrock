import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { useContactTasks } from "@/services/opportunities";
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
 * deliberately disabled here — a contact-only task lacks a clear parent
 * (WhatId), so creating one belongs in the account or opp panels where
 * the parent is unambiguous. Inline edits on existing tasks (status /
 * priority / owner / due date) work the same as elsewhere.
 */
function ContactTasks({ contactId }: { contactId: string }) {
  const { data: tasks = [], isLoading } = useContactTasks(contactId);

  // Surface the parent record (opp / account / etc.) on each row so the
  // user can see at a glance whether this is a "Call about Acme proposal"
  // vs. "Birthday card" — different intents, same WhoId.
  const contextResolver = (t: SfTask) => t.WhatName ?? null;

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      emptyMessage="No tasks linked to this contact."
      contextResolver={contextResolver}
    />
  );
}
