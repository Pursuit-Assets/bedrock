import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import {
  useCreateTask,
  useOpportunityTasks,
} from "@/services/opportunities";

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
  const createTask = useCreateTask();

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task — press Enter to create"
      emptyMessage="No open tasks for this opportunity."
      onCreate={async (subject) => {
        await createTask.mutateAsync({ opportunityId, body: { Subject: subject } });
      }}
    />
  );
}
