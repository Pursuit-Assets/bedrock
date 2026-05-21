import { useMemo } from "react";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import {
  useCreateTask,
  useOpportunityTasks,
} from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";

export const OPP_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

export function OpportunityExpandPanel({
  opportunityId,
}: {
  opportunityId: string;
}) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <OppTasks opportunityId={opportunityId} />,
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ opportunityId }}
              emptyMessage="No emails, meetings, or notes recorded for this opportunity yet."
            />
          ),
        },
      ]}
    />
  );
}

function OppTasks({ opportunityId }: { opportunityId: string }) {
  const { data: tasks = [], isLoading } = useOpportunityTasks(opportunityId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateTask();

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task — press Enter to create"
      emptyMessage="No open tasks for this opportunity."
      ownerOptions={ownerOptions}
      onCreate={async ({ subject, ownerId, activityDate }) => {
        await createTask.mutateAsync({
          opportunityId,
          body: {
            Subject: subject,
            OwnerId: ownerId ?? undefined,
            ActivityDate: activityDate ?? undefined,
          },
        });
      }}
    />
  );
}
