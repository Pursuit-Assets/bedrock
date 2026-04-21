import React from 'react';
import { Box, Typography, IconButton, Tooltip } from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import type { GanttRow } from './types';
import { ROW_HEIGHT, TASK_STATUS_COLOR } from './constants';
import { resolveOwners, initials } from './helpers';
import { useActiveUsers } from './useActiveUsers';

interface GanttTaskListProps {
  rows: GanttRow[];
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
  onToggleCollapse: (id: string) => void;
  onTaskClick: (taskId: string) => void;
}

const GanttTaskList: React.FC<GanttTaskListProps> = ({
  rows, scrollRef, onScroll, onToggleCollapse, onTaskClick,
}) => {
  const { activeUsers } = useActiveUsers();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box sx={{
        height: 32, display: 'flex', alignItems: 'center', px: 1.5,
        borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'grey.50',
      }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>Name</Typography>
      </Box>

      {/* Scrollable list */}
      <Box
        ref={scrollRef as any}
        onScroll={onScroll}
        sx={{ flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 300px)' }}
      >
        {rows.map((row) => {
          const isGroup = row.type === 'workstream' || row.type === 'milestone';
          const paddingLeft = row.indent * 24 + 8;

          return (
            <Box
              key={row.id}
              sx={{
                height: ROW_HEIGHT, display: 'flex', alignItems: 'center',
                pl: `${paddingLeft}px`, pr: 1,
                borderBottom: '1px solid', borderColor: 'divider',
                cursor: isGroup ? 'pointer' : row.type === 'task' ? 'pointer' : 'default',
                '&:hover': { bgcolor: 'action.hover' },
                bgcolor: row.type === 'workstream' ? 'grey.50' : 'transparent',
              }}
              onClick={() => {
                if (isGroup) onToggleCollapse(row.id);
                else if (row.type === 'task') onTaskClick(row.id);
              }}
            >
              {/* Collapse arrow for groups */}
              {isGroup ? (
                <IconButton size="small" sx={{ p: 0, mr: 0.5 }}>
                  {row.isCollapsed
                    ? <ChevronRightIcon sx={{ fontSize: 16 }} />
                    : <ExpandMoreIcon sx={{ fontSize: 16 }} />
                  }
                </IconButton>
              ) : (
                <Box sx={{
                  width: 8, height: 8, borderRadius: '50%', mr: 1,
                  bgcolor: TASK_STATUS_COLOR[row.status] || '#9e9e9e',
                  flexShrink: 0,
                }} />
              )}

              {/* Label */}
              <Tooltip title={row.label} enterDelay={500}>
                <Typography
                  variant={row.type === 'workstream' ? 'subtitle2' : 'body2'}
                  sx={{
                    flex: 1, fontSize: row.type === 'task' ? '0.75rem' : '0.8rem',
                    fontWeight: isGroup ? 600 : 400,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {row.label}
                </Typography>
              </Tooltip>

              {/* Owner initials for tasks — one token per resolved owner, plus Other if any */}
              {row.type === 'task' && (row.ownerIds?.length || row.owner) && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', ml: 0.5 }}>
                  {[
                    ...resolveOwners(row.ownerIds, activeUsers).map((o) => initials(o.name)),
                    ...(row.owner ? [row.owner] : []),
                  ].join(' / ')}
                </Typography>
              )}

              {/* Progress for groups */}
              {isGroup && (
                <Typography variant="caption" sx={{ fontSize: '0.65rem', fontWeight: 600, ml: 0.5 }}>
                  {row.progress}%
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export default GanttTaskList;
