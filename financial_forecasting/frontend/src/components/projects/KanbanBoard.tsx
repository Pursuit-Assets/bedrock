import React, { useState, useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import {
  DndContext, DragOverlay, closestCorners, PointerSensor,
  KeyboardSensor, useSensor, useSensors,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import type { ActiveUser, Workstream, ProjectMutations, FlatTask, TaskStatus } from './types';
import { TASK_STATUSES } from './constants';
import { flattenTasks, groupByStatus } from './helpers';
import KanbanColumn from './KanbanColumn';
import KanbanCard from './KanbanCard';
import TaskDetailDialog from './TaskDetailDialog';

interface KanbanBoardProps {
  workstreams: Workstream[];
  mutations: ProjectMutations;
  activeUsers: ActiveUser[];
}

const KanbanBoard: React.FC<KanbanBoardProps> = ({ workstreams, mutations, activeUsers }) => {
  const flatTasks = useMemo(() => flattenTasks(workstreams), [workstreams]);
  const grouped = useMemo(() => groupByStatus(flatTasks), [flatTasks]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<FlatTask | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const activeTask = activeId ? flatTasks.find(t => t.id === activeId) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    // The droppable column ID is the status string
    const newStatus = (over.data.current?.status || over.id) as TaskStatus;
    const task = flatTasks.find(t => t.id === taskId);
    if (task && newStatus && task.status !== newStatus) {
      mutations.updateTaskStatus(taskId, newStatus);
    }
  }

  if (flatTasks.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No tasks to display. Add tasks in the List view.
      </Typography>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <Box sx={{
          display: 'flex', gap: 1.5, overflowX: 'auto', pb: 2,
          minHeight: 400, alignItems: 'flex-start',
        }}>
          {TASK_STATUSES.map(status => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={grouped[status] || []}
              onCardClick={setSelectedTask}
            />
          ))}
        </Box>
        <DragOverlay dropAnimation={null}>
          {activeTask ? <KanbanCard task={activeTask} isDragOverlay /> : null}
        </DragOverlay>
      </DndContext>

      <TaskDetailDialog
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        mutations={mutations}
        activeUsers={activeUsers}
      />
    </>
  );
};

export default KanbanBoard;
