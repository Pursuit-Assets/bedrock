import React from 'react';
import { Box, Typography, Card, CardContent, Chip, Tooltip, Avatar } from '@mui/material';
import { Link as LinkIcon } from '@mui/icons-material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { FlatTask } from './types';
import { PRIORITY_BORDER_COLOR } from './constants';
import { formatRelativeDeadline, resolveOwners, initials } from './helpers';
import { useActiveUsers } from './useActiveUsers';

interface KanbanCardProps {
  task: FlatTask;
  isDragOverlay?: boolean;
  onCardClick?: (task: FlatTask) => void;
}

const KanbanCard: React.FC<KanbanCardProps> = ({ task, isDragOverlay, onCardClick }) => {
  const { activeUsers } = useActiveUsers();
  const owners = resolveOwners(task.owner_ids, activeUsers);
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: task.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    ...(isDragOverlay ? { transform: 'rotate(2deg)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' } : {}),
  };

  const relDeadline = task.deadline ? formatRelativeDeadline(task.deadline) : null;

  const handleClick = (e: React.MouseEvent) => {
    // Only open detail on click, not on drag
    if (!isDragging && onCardClick) {
      onCardClick(task);
    }
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      variant="outlined"
      sx={{
        cursor: 'grab',
        borderLeft: `3px solid ${PRIORITY_BORDER_COLOR[task.milestonePriority] || '#9e9e9e'}`,
        '&:hover': { boxShadow: 2 },
      }}
    >
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        {/* Title — 2 line truncate */}
        <Typography variant="body2" sx={{
          fontWeight: 500, mb: 0.75,
          display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {task.title}
        </Typography>

        {/* Bottom row */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip
            label={task.milestoneTitle}
            size="small"
            variant="outlined"
            sx={{ fontSize: '0.6rem', height: 18 }}
          />
          {relDeadline && (
            <Typography variant="caption" sx={{
              color: relDeadline.color, fontWeight: 500, fontSize: '0.65rem',
            }}>
              {relDeadline.text}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {task.dependsOn && task.dependsOn.length > 0 && (
            <Tooltip title={`${task.dependsOn.length} dependenc${task.dependsOn.length === 1 ? 'y' : 'ies'}`}>
              <LinkIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
            </Tooltip>
          )}
          {owners.map((o) => (
            <Tooltip key={o.id} title={o.name}>
              <Avatar sx={{ width: 22, height: 22, fontSize: '0.6rem', bgcolor: 'primary.light' }}>
                {initials(o.name)}
              </Avatar>
            </Tooltip>
          ))}
          {task.owner && (
            <Tooltip title={`Other: ${task.owner}`}>
              <Chip
                label={task.owner}
                size="small"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.6rem' }}
              />
            </Tooltip>
          )}
        </Box>
      </CardContent>
    </Card>
  );
};

export default KanbanCard;
