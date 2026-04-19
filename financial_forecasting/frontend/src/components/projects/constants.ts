import React from 'react';
import type { TaskStatus, MilestoneStatus, GanttZoom } from './types';

export const TASK_STATUSES: TaskStatus[] = ['Not Started', 'In Progress', 'Completed', 'Blocked', 'On Hold'];
export const MILESTONE_STATUSES: MilestoneStatus[] = ['On Track', 'At Risk', 'Needs Attention', 'Completed'];

/** Milestone phase / priority categories. Mirrors PRIORITY_BORDER_COLOR keys. */
export const MILESTONE_PHASES: string[] = ['Now', 'Later', 'On-going'];

/** Color per milestone status — used by the inline-edit StatusPillCell. */
export const MILESTONE_STATUS_COLOR: Record<string, string> = {
  'On Track': '#2e7d32',         // green
  'At Risk': '#ed6c02',          // orange
  'Needs Attention': '#d32f2f',  // red
  'Completed': '#1976d2',        // blue
};

export const TASK_STATUS_COLOR: Record<string, string> = {
  'Not Started': '#9e9e9e',
  'In Progress': '#1565c0',
  'Completed': '#4caf50',
  'Blocked': '#d32f2f',
  'On Hold': '#bdbdbd',
};

export const STATUS_CHIP: Record<string, { color: 'success' | 'warning' | 'error' | 'default'; icon: string }> = {
  'On Track': { color: 'success', icon: 'check' },
  'At Risk': { color: 'warning', icon: 'warning' },
  'Needs Attention': { color: 'error', icon: 'error' },
  'Completed': { color: 'success', icon: 'check' },
};

export const ROW_HEIGHT = 36;

export const GANTT_DAY_WIDTHS: Record<GanttZoom, number> = {
  day: 40,
  week: 16,
  month: 5,
};

export const PRIORITY_BORDER_COLOR: Record<string, string> = {
  'Now': '#1976d2',
  'Later': '#9e9e9e',
  'On-going': '#2e7d32',
};

// Deterministic AIJI project ID (matches seed.sql).
// Used as default selected project when no localStorage pref exists.
// Will be phased out as multi-project becomes the standard workflow.
export const AIJI_PROJECT_ID = 'a0000000-0000-4000-8000-000000000001';
