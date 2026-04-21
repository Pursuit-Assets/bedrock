import React, { useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Notifications as NotificationsIcon,
  CheckCircleOutline as AllCaughtUpIcon,
  PersonAdd as PersonAddIcon,
  SwapHoriz as SwapHorizIcon,
  EventBusy as EventBusyIcon,
  LockOpenOutlined as LockOpenOutlinedIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  OpenInNew as OpenInNewIcon,
  DoneAll as DoneAllIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow, parseISO } from 'date-fns';
import type { CrmNotification, NotificationType } from '../types/notifications';
import { getStageHexColor } from '../types/salesforce';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NotificationDropdownProps {
  notifications: CrmNotification[];
  unreadCount: number;
  badgeColor: 'error' | 'warning' | 'default';
  onMarkOneRead: (id: string) => void;
  onMarkAllRead: () => void;
  onOpenTask: (taskId: string, whatId: string | null) => void;
  onOpenOpp: (oppId: string, data?: Record<string, any>) => void;
  loading?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, string> = {
  error: '#d32f2f',
  warning: '#ed6c02',
  info: '#1976d2',
};

const TYPE_ICONS: Record<NotificationType, React.ReactElement> = {
  'task-assignment': <PersonAddIcon sx={{ fontSize: 18 }} />,
  'ownership-gained': <SwapHorizIcon sx={{ fontSize: 18 }} />,
  'ownership-lost': <SwapHorizIcon sx={{ fontSize: 18 }} />,
  'close-date-warning': <EventBusyIcon sx={{ fontSize: 18 }} />,
  'permission-request': <LockOpenOutlinedIcon sx={{ fontSize: 18 }} />,
};

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const NotificationDropdown: React.FC<NotificationDropdownProps> = ({
  notifications,
  unreadCount,
  badgeColor,
  onMarkOneRead,
  onMarkAllRead,
  onOpenTask,
  onOpenOpp,
  loading,
}) => {
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const open = Boolean(anchorEl);

  const handleOpen = (e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
  };
  const handleClose = () => {
    setAnchorEl(null);
    setExpandedId(null);
  };

  const handleToggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const handleAction = (n: CrmNotification) => {
    handleClose();
    if (n.type === 'permission-request') {
      navigate('/settings?tab=profiles');
    } else if (n.type === 'task-assignment' && n.taskId) {
      onOpenTask(n.taskId, n.whatId ?? null);
    } else if (n.opportunityId) {
      onOpenOpp(n.opportunityId);
    }
  };

  return (
    <>
      <IconButton color="inherit" sx={{ mr: 1 }} onClick={handleOpen}>
        <Badge
          badgeContent={unreadCount}
          color={badgeColor}
          invisible={unreadCount === 0}
        >
          <NotificationsIcon />
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              width: 380,
              maxHeight: 520,
              // Prevent horizontal scroll when a long subtitle / chip label
              // overflows the fixed 380px width. Children are responsible for
              // wrapping / truncating via `noWrap` or `wordBreak`.
              overflowX: 'hidden',
            },
          },
        }}
      >
        {/* Header */}
        <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              Notifications
            </Typography>
            {unreadCount > 0 && (
              <Chip
                label={`${unreadCount} new`}
                size="small"
                color="primary"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            )}
          </Box>
          {unreadCount > 0 && (
            <Tooltip title="Mark all as read">
              <IconButton
                size="small"
                onClick={onMarkAllRead}
                sx={{ color: 'text.secondary' }}
              >
                <DoneAllIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Divider />

        {/* Body */}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : notifications.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4, px: 2 }}>
            <AllCaughtUpIcon sx={{ fontSize: 40, color: 'success.main', mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              You're all caught up
            </Typography>
          </Box>
        ) : (
          <List disablePadding sx={{ py: 0.5, maxHeight: 400, overflowY: 'auto' }}>
            {notifications.map((n) => {
              const isExpanded = expandedId === n.id;
              const borderColor = SEVERITY_COLORS[n.severity] || SEVERITY_COLORS.info;

              return (
                <React.Fragment key={n.id}>
                  {/* Collapsed row */}
                  <ListItemButton
                    onClick={() => handleToggle(n.id)}
                    sx={{
                      px: 2,
                      py: 0.75,
                      borderLeft: `3px solid ${borderColor}`,
                      alignItems: 'flex-start',
                    }}
                  >
                    {/* Icon */}
                    <Box sx={{ mr: 1.5, mt: 0.25, color: borderColor, flexShrink: 0 }}>
                      {TYPE_ICONS[n.type]}
                    </Box>

                    {/* Text */}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: n.isNew ? 600 : 400 }}>
                          {n.title}
                        </Typography>
                        {n.isNew && (
                          <Box
                            sx={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              bgcolor: 'primary.main',
                              flexShrink: 0,
                            }}
                          />
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        component="div"
                      >
                        {n.subtitle}
                      </Typography>
                    </Box>

                    {/* Time + per-item check-off + expand.
                        The check-off icon is shown for unread items only and
                        lets users dismiss a single notification without having
                        to expand it first. Uses stopPropagation so the row
                        doesn't toggle when the icon is clicked. */}
                    <Box sx={{ ml: 1, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                      <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap', mr: 0.25 }}>
                        {relativeTime(n.timestamp)}
                      </Typography>
                      {n.isNew && (
                        <Tooltip title="Mark as read">
                          <IconButton
                            size="small"
                            onClick={(e) => { e.stopPropagation(); onMarkOneRead(n.id); }}
                            sx={{
                              p: 0.25,
                              mr: 0.25,
                              color: 'text.disabled',
                              '&:hover': { color: 'primary.main', bgcolor: 'transparent' },
                            }}
                          >
                            <CheckCircleIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                      {isExpanded ? (
                        <ExpandLessIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                      ) : (
                        <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                      )}
                    </Box>
                  </ListItemButton>

                  {/* Expanded detail */}
                  <Collapse in={isExpanded} unmountOnExit>
                    <Box
                      sx={{
                        px: 2,
                        py: 1.5,
                        pl: 5.5,
                        bgcolor: 'action.hover',
                        borderLeft: `3px solid ${borderColor}`,
                      }}
                    >
                      {/* Type-specific details */}
                      {n.type === 'task-assignment' && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
                            {n.subtitle}
                          </Typography>
                        </Box>
                      )}

                      {(n.type === 'ownership-gained' || n.type === 'ownership-lost') && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {n.subtitle}
                          </Typography>
                        </Box>
                      )}

                      {n.type === 'close-date-warning' && (
                        <Box sx={{ mb: 1, maxWidth: '100%' }}>
                          <Chip
                            label={n.subtitle}
                            size="small"
                            sx={{
                              bgcolor: getStageHexColor(n.subtitle.split('(')[0].trim()) + '20',
                              fontSize: '0.7rem',
                              height: 22,
                              maxWidth: '100%',
                              '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                            }}
                          />
                        </Box>
                      )}

                      {n.type === 'permission-request' && (
                        <Box sx={{ mb: 1, maxWidth: '100%' }}>
                          <Chip
                            label={n.subtitle}
                            size="small"
                            color="info"
                            variant="outlined"
                            sx={{
                              fontSize: '0.7rem',
                              height: 22,
                              maxWidth: '100%',
                              '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                            }}
                          />
                        </Box>
                      )}

                      {/* Action buttons */}
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                          onClick={() => handleAction(n)}
                          sx={{ textTransform: 'none', fontSize: '0.75rem' }}
                        >
                          {n.type === 'task-assignment' ? 'Open Task' : n.type === 'permission-request' ? 'View Profiles' : 'Open Opportunity'}
                        </Button>
                        {n.isNew && (
                          <Tooltip title="Mark as read">
                            <IconButton
                              size="small"
                              onClick={(e) => { e.stopPropagation(); onMarkOneRead(n.id); }}
                              sx={{ color: 'text.secondary' }}
                            >
                              <CheckCircleIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </Box>
                  </Collapse>
                </React.Fragment>
              );
            })}
          </List>
        )}

        {/* Footer */}
        <Divider />
        <Box sx={{ p: 1, display: 'flex', justifyContent: 'center', gap: 1 }}>
          <Button
            size="small"
            onClick={() => { handleClose(); navigate('/priorities'); }}
            sx={{ textTransform: 'none', fontSize: '0.75rem' }}
          >
            View Priorities
          </Button>
          <Button
            size="small"
            onClick={() => { handleClose(); navigate('/details'); }}
            sx={{ textTransform: 'none', fontSize: '0.75rem' }}
          >
            View Pipeline
          </Button>
        </Box>
      </Popover>
    </>
  );
};

export default NotificationDropdown;
