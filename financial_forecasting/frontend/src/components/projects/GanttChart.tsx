import React, { useState, useMemo, useRef, useCallback } from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { ActiveUser, Workstream, ProjectMutations, FlatTask, GanttZoom } from './types';
import { GANTT_DAY_WIDTHS } from './constants';
import { buildGanttRows, getTimelineRange, buildDependencyEdges, flattenTasks } from './helpers';
import GanttTaskList from './GanttTaskList';
import GanttTimeline from './GanttTimeline';
import TaskDetailDialog from './TaskDetailDialog';

interface GanttChartProps {
  workstreams: Workstream[];
  mutations: ProjectMutations;
  activeUsers: ActiveUser[];
}

const GanttChart: React.FC<GanttChartProps> = ({ workstreams, mutations, activeUsers }) => {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<GanttZoom>('week');
  const [selectedTask, setSelectedTask] = useState<FlatTask | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildGanttRows(workstreams, collapsedIds), [workstreams, collapsedIds]);
  const timelineRange = useMemo(() => getTimelineRange(rows), [rows]);
  const depEdges = useMemo(() => buildDependencyEdges(rows), [rows]);
  const flatTasks = useMemo(() => flattenTasks(workstreams), [workstreams]);
  const dayWidth = GANTT_DAY_WIDTHS[zoom];

  // Sync vertical scroll between left list and right timeline
  const handleScroll = useCallback((source: 'list' | 'timeline') => {
    const scrollTop = source === 'list'
      ? listScrollRef.current?.scrollTop
      : scrollRef.current?.scrollTop;
    if (scrollTop !== undefined) {
      if (source === 'list' && scrollRef.current) scrollRef.current.scrollTop = scrollTop;
      if (source === 'timeline' && listScrollRef.current) listScrollRef.current.scrollTop = scrollTop;
    }
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleTaskClick = useCallback((taskId: string) => {
    const task = flatTasks.find(t => t.id === taskId);
    if (task) setSelectedTask(task);
  }, [flatTasks]);

  if (rows.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        No tasks to display. Add tasks in the List view.
      </Typography>
    );
  }

  return (
    <Box>
      {/* Zoom controls */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <ToggleButtonGroup
          size="small"
          value={zoom}
          exclusive
          onChange={(_, v) => v && setZoom(v)}
        >
          <ToggleButton value="day">Day</ToggleButton>
          <ToggleButton value="week">Week</ToggleButton>
          <ToggleButton value="month">Month</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
        <PanelGroup orientation="horizontal">
          <Panel defaultSize={30} minSize={20}>
            <GanttTaskList
              rows={rows}
              scrollRef={listScrollRef}
              onScroll={() => handleScroll('list')}
              onToggleCollapse={toggleCollapse}
              onTaskClick={handleTaskClick}
            />
          </Panel>
          <PanelResizeHandle style={{ width: 4, background: '#e0e0e0', cursor: 'col-resize' }} />
          <Panel defaultSize={70} minSize={40}>
            <GanttTimeline
              rows={rows}
              timelineRange={timelineRange}
              dayWidth={dayWidth}
              zoom={zoom}
              depEdges={depEdges}
              scrollRef={scrollRef}
              onScroll={() => handleScroll('timeline')}
              mutations={mutations}
            />
          </Panel>
        </PanelGroup>
      </Box>

      <TaskDetailDialog
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        mutations={mutations}
        activeUsers={activeUsers}
      />
    </Box>
  );
};

export default GanttChart;
