import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  AppBar,
  Box,
  CssBaseline,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography,
  useTheme,
  useMediaQuery,
  Badge,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  Chip,
} from '@mui/material';
import {
  Menu as MenuIcon,
  TableChart as TableChartIcon,
  TrendingUp as TrendingUpIcon,
  AttachMoney as AttachMoneyIcon,
  BuildCircle as ToolsIcon,
  Settings as SettingsIcon,
  AccountCircle as AccountCircleIcon,
  Sync as SyncIcon,
  Cloud as CloudIcon,
  CloudOff as CloudOffIcon,
  Home as HomeIcon,
  RateReview as ReviewIcon,
  Science as ResearchIcon,
  AccountTree as ProjectsIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import BedrockLogo from './BedrockLogo';
import NotificationDropdown from './NotificationDropdown';
import TaskPanel from './TaskPanel';
import OpportunityEditDialog from './OpportunityEditDialog';
import AccountEditDialog from './AccountEditDialog';
import ContactEditDialog from './ContactEditDialog';
import GlobalSearch from './GlobalSearch';
import PlatformIdentityBanner from './PlatformIdentityBanner';
import { InboxTask } from './TaskInbox';
import { useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';

import { apiService } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { useNotifications } from '../hooks/useNotifications';

const drawerWidth = 200;
const collapsedDrawerWidth = 48;

interface LayoutProps {
  children: React.ReactNode;
}

// Each nav item carries a short `subtitle` used in two places:
//   1. Sidebar tooltip on hover (discoverable on first scan)
//   2. Page header subtitle, rendered by Layout above page content (reinforces
//      what the page is and what it's for).
// Keep them scannable, ~60-110 chars, sentence case.
const ALL_MENU_ITEMS = [
  {
    text: 'Progress',
    subtitle: 'Team pipeline accountability — real-time goal tracking per RM.',
    icon: <HomeIcon />,
    path: '/dashboard',
  },
  {
    text: 'Priorities',
    subtitle: 'Your weekly action list — opportunities and tasks that need attention now.',
    icon: <TrendingUpIcon />,
    path: '/priorities',
  },
  {
    text: 'Reports',
    subtitle: 'Configurable inline-editable tables for Opportunities, Accounts, Contacts, Leads, and Tasks.',
    icon: <TableChartIcon />,
    path: '/reports',
  },
  {
    text: 'Projects',
    subtitle: 'Workstream milestones and tasks — list, Kanban, and Gantt views.',
    icon: <ProjectsIcon />,
    path: '/projects',
  },
  {
    text: 'Settings',
    subtitle: 'Targets, users, permissions, and integrations.',
    icon: <SettingsIcon />,
    path: '/settings',
  },
];

const MVP_PATHS = new Set(['/priorities', '/dashboard', '/reports', '/projects', '/settings']);

// Map nav paths to required permissions (undefined = no permission needed)
const NAV_PERMISSIONS: Record<string, string | ((can: (k: string) => boolean) => boolean) | undefined> = {
  '/projects': 'view_projects',
  '/settings': undefined, // visible to all, tabs gated inside
};

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout, connectSalesforce } = useAuth();
  const { can } = usePermissions();

  const [mobileOpen, setMobileOpen] = useState(false);

  // MVP nav: show Priorities, Progress, Reports, Projects, Settings. Set REACT_APP_NAV_PHASE=FULL for all pages.
  const navPhase = process.env.REACT_APP_NAV_PHASE || 'MVP';
  const menuItems = useMemo(() => {
    let items = ALL_MENU_ITEMS;
    if (navPhase === 'MVP') {
      items = items.filter((item) => MVP_PATHS.has(item.path));
    }
    // Filter by permissions
    return items.filter((item) => {
      const perm = NAV_PERMISSIONS[item.path];
      if (perm === undefined) return true;
      if (typeof perm === 'function') return perm(can);
      return can(perm);
    });
  }, [navPhase, can]);

  // Current nav item drives the page-identity header (title + subtitle).
  // We match against ALL_MENU_ITEMS (not the permission-filtered `menuItems`)
  // so the header still renders on pages the user can navigate to directly by
  // URL even if the item is hidden from their sidebar. We also handle the
  // legacy /pipeline alias so the redirect target still matches Reports.
  const currentMenuItem = useMemo(() => {
    const path = location.pathname === '/pipeline' ? '/reports' : location.pathname;
    return ALL_MENU_ITEMS.find((item) => item.path === path);
  }, [location.pathname]);

  // Prefetch CRM data when authenticated so search + edit dialogs have warm cache
  useEffect(() => {
    if (!user) return;
    queryClient.prefetchQuery('opportunities', async () => {
      const response = await apiService.getOpportunities();
      return response.data;
    });
    queryClient.prefetchQuery('accounts', async () => {
      const response = await apiService.getAccounts();
      return response.data;
    });
    queryClient.prefetchQuery('all-contacts', async () => {
      const response = await apiService.getContacts();
      return response.data;
    });
  }, [user, queryClient]);
  const [drawerHovered, setDrawerHovered] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [syncAnchorEl, setSyncAnchorEl] = useState<null | HTMLElement>(null);

  // Query for health status
  const { refetch: refetchHealth } = useQuery(
    'health',
    () => apiService.servicesHealth(),
    {
      onError: (error) => {
        console.error('Health check failed:', error);
      },
    }
  );

  // Fetch tasks for notification dropdown (React Query dedupes with MyDashboard)
  const { data: tasksData, isLoading: tasksLoading } = useQuery(
    ['my-tasks'],
    async () => {
      const response = await apiService.getMyTasks();
      return response.data?.data || response.data || [];
    },
    { staleTime: 5 * 60 * 1000 }
  );

  const inboxTasks: InboxTask[] = useMemo(() => {
    const raw = Array.isArray(tasksData) ? tasksData : [];
    return raw.map((t: any) => ({
      Id: t.Id,
      Subject: t.Subject || 'Untitled Task',
      Status: t.Status || 'Not Started',
      Priority: t.Priority || 'Normal',
      ActivityDate: t.ActivityDate || null,
      Description: t.Description || null,
      OwnerId: t.OwnerId,
      OwnerName: t.Owner?.Name || t.OwnerName || null,
      CreatedById: t.CreatedById || null,
      CreatedByName: t.CreatedBy?.Name || null,
      WhatId: t.WhatId || null,
      OpportunityName: null,
      WhoId: t.WhoId || null,
      WhoName: t.Who?.Name || t.WhoName || null,
      CreatedDate: t.CreatedDate || null,
    }));
  }, [tasksData]);

  // ---- Notifications hook ----
  const {
    notifications,
    unreadCount,
    badgeColor: notifBadgeColor,
    markOneRead,
    markAllRead,
    loading: notifLoading,
  } = useNotifications(
    inboxTasks,
    user?.salesforce_user_id ?? null,
    user?.salesforce_user_name ?? null,
  );

  // ---- Notification overlay state ----
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [taskPanelOpp, setTaskPanelOpp] = useState<any>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [orphanTask, setOrphanTask] = useState<any>(null);
  const [editOppId, setEditOppId] = useState<string | null>(null);
  const [editOppData, setEditOppData] = useState<Record<string, any> | undefined>();

  // ---- Global search dialog state ----
  const [editAccountId, setEditAccountId] = useState<string | null>(null);
  const [editAccountData, setEditAccountData] = useState<Record<string, any> | undefined>();
  const [editContactId, setEditContactId] = useState<string | null>(null);
  const [editContactData, setEditContactData] = useState<Record<string, any> | undefined>();

  const hasOpenDialog = !!editOppId || !!editAccountId || !!editContactId || taskPanelOpen;

  const handleOpenTask = useCallback((taskId: string, whatId: string | null, fallbackTaskData?: Record<string, any>) => {
    if (whatId) {
      const opps = queryClient.getQueryData('opportunities') as any[] | undefined;
      const rawOpps = Array.isArray(opps) ? opps : ((opps as any)?.data || []);
      const opp = rawOpps.find((o: any) => o.Id === whatId);
      if (opp) {
        setTaskPanelOpp(opp);
        setSelectedTaskId(taskId);
        setOrphanTask(null);
      } else {
        // Opp not in cache — use orphan mode with inboxTasks or fallback data
        const task = inboxTasks.find((t) => t.Id === taskId);
        const taskSource = task || fallbackTaskData;
        setTaskPanelOpp(null);
        setSelectedTaskId(null);
        setOrphanTask(taskSource ? {
          Id: taskSource.Id,
          Subject: taskSource.Subject,
          Status: taskSource.Status,
          Priority: taskSource.Priority,
          ActivityDate: taskSource.ActivityDate,
          Description: taskSource.Description || null,
          OwnerId: taskSource.OwnerId,
          OwnerName: taskSource.OwnerName || taskSource.Owner?.Name || null,
          WhatId: whatId,
        } : null);
      }
    } else {
      // No opportunity — orphan mode with inboxTasks or fallback data
      const task = inboxTasks.find((t) => t.Id === taskId);
      const taskSource = task || fallbackTaskData;
      setTaskPanelOpp(null);
      setSelectedTaskId(null);
      setOrphanTask(taskSource ? {
        Id: taskSource.Id,
        Subject: taskSource.Subject,
        Status: taskSource.Status,
        Priority: taskSource.Priority,
        ActivityDate: taskSource.ActivityDate,
        Description: taskSource.Description || null,
        OwnerId: taskSource.OwnerId,
        OwnerName: taskSource.OwnerName || taskSource.Owner?.Name || null,
        WhatId: null,
      } : null);
    }
    setTaskPanelOpen(true);
  }, [queryClient, inboxTasks]);

  const handleOpenOpp = useCallback((oppId: string, data?: Record<string, any>) => {
    setEditOppId(oppId);
    setEditOppData(data);
  }, []);

  const handleOpenAccount = useCallback((accountId: string, data?: Record<string, any>) => {
    setEditAccountId(accountId);
    setEditAccountData(data);
  }, []);

  const handleOpenContact = useCallback((contactId: string, data?: Record<string, any>) => {
    setEditContactId(contactId);
    setEditContactData(data);
  }, []);

  const handleCloseTaskPanel = useCallback(() => {
    setTaskPanelOpen(false);
    setTaskPanelOpp(null);
    setSelectedTaskId(null);
    setOrphanTask(null);
  }, []);

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleMenuClick = (path: string) => {
    navigate(path);
    if (isMobile) {
      setMobileOpen(false);
    }
  };

  const handleProfileMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleProfileMenuClose = () => {
    setAnchorEl(null);
  };

  const handleSyncMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setSyncAnchorEl(event.currentTarget);
  };

  const handleSyncMenuClose = () => {
    setSyncAnchorEl(null);
  };

  const handleSync = async (syncType: string) => {
    try {
      await apiService.triggerSync(syncType as 'all' | 'salesforce' | 'intacct');
      toast.success(`${syncType} sync triggered successfully`);
      refetchHealth();
    } catch (error) {
      toast.error(`Failed to trigger ${syncType} sync`);
    }
    handleSyncMenuClose();
  };

  const isExpanded = isMobile || drawerHovered;
  const currentDrawerWidth = isExpanded ? drawerWidth : collapsedDrawerWidth;

  const drawer = (
    <div>
      <Toolbar sx={{ justifyContent: isExpanded ? 'flex-start' : 'center', gap: 1, minHeight: '48px !important', height: 48 }}>
        <BedrockLogo sx={{ color: theme.palette.primary.main, fontSize: 22 }} />
        {isExpanded && (
          <Typography
            variant="h6"
            noWrap
            component="div"
            sx={{ fontWeight: 600 }}
          >
            Bedrock
          </Typography>
        )}
      </Toolbar>
      <Divider />
      <List>
        {menuItems.map((item) => {
          // Tooltip is only useful when the rail is collapsed — when expanded,
          // the nav label is already visible so the tooltip would duplicate it.
          const tooltipTitle = isExpanded ? '' : `${item.text} — ${item.subtitle}`;
          return (
            <ListItem key={item.text} disablePadding>
              <Tooltip title={tooltipTitle} placement="right" arrow disableInteractive>
                <ListItemButton
                  selected={location.pathname === item.path}
                  onClick={() => handleMenuClick(item.path)}
                  sx={{
                    justifyContent: isExpanded ? 'initial' : 'center',
                    px: 1.5,
                    py: 0.75,
                    '&.Mui-selected': {
                      backgroundColor: theme.palette.primary.main + '20',
                      borderRight: `3px solid ${theme.palette.primary.main}`,
                      '& .MuiListItemIcon-root': {
                        color: theme.palette.primary.main,
                      },
                      '& .MuiListItemText-primary': {
                        color: theme.palette.primary.main,
                        fontWeight: 600,
                      },
                    },
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: 0,
                      mr: isExpanded ? 2 : 'auto',
                      justifyContent: 'center',
                      '& .MuiSvgIcon-root': { fontSize: 20 },
                    }}
                  >
                    {item.icon}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.text}
                    sx={{ display: isExpanded ? 'block' : 'none' }}
                  />
                </ListItemButton>
              </Tooltip>
            </ListItem>
          );
        })}
      </List>
    </div>
  );

  return (
    <Box sx={{ display: 'flex' }}>
      <CssBaseline />
      <AppBar
        position="fixed"
        sx={{
          width: { md: `calc(100% - ${collapsedDrawerWidth}px)` },
          ml: { md: `${collapsedDrawerWidth}px` },
          backgroundColor: 'white',
          color: 'text.primary',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        }}
      >
        <Toolbar sx={{ minHeight: '48px !important', height: 48, px: { xs: 1, sm: 2 } }}>
          <IconButton
            color="inherit"
            aria-label="open drawer"
            edge="start"
            onClick={handleDrawerToggle}
            sx={{ mr: 1, display: { md: 'none' } }}
            size="small"
          >
            <MenuIcon fontSize="small" />
          </IconButton>
          
          <Typography variant="h6" noWrap component="div" sx={{ fontSize: '0.95rem', mr: 1 }}>
            {currentMenuItem?.text || 'Overview'}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          {/* Global Search */}
          {user?.salesforce_connected && (
            <GlobalSearch
              onOpenOpportunity={handleOpenOpp}
              onOpenAccount={handleOpenAccount}
              onOpenContact={handleOpenContact}
              onOpenTask={handleOpenTask}
              hasOpenDialog={hasOpenDialog}
            />
          )}

          {/* Sync Menu */}
          <IconButton
            color="inherit"
            onClick={handleSyncMenuOpen}
            size="small"
            sx={{ mr: 0.5 }}
          >
            <SyncIcon fontSize="small" />
          </IconButton>
          <Menu
            anchorEl={syncAnchorEl}
            open={Boolean(syncAnchorEl)}
            onClose={handleSyncMenuClose}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'right',
            }}
            transformOrigin={{
              vertical: 'top',
              horizontal: 'right',
            }}
          >
            <MenuItem onClick={() => handleSync('all')}>Sync All Data</MenuItem>
            <MenuItem onClick={() => handleSync('salesforce')}>Sync Salesforce</MenuItem>
            <MenuItem onClick={() => handleSync('intacct')}>Sync Sage Intacct</MenuItem>
          </Menu>

          {/* Notifications Dropdown */}
          <NotificationDropdown
            notifications={notifications}
            unreadCount={unreadCount}
            badgeColor={notifBadgeColor}
            onMarkOneRead={markOneRead}
            onMarkAllRead={markAllRead}
            onOpenTask={handleOpenTask}
            onOpenOpp={handleOpenOpp}
            loading={tasksLoading || notifLoading}
          />

          {/* SF Connection Indicator */}
          {!user?.salesforce_connected && (
            <Chip
              icon={<CloudOffIcon />}
              label="Connect SF"
              size="small"
              color="warning"
              variant="outlined"
              onClick={() => connectSalesforce()}
              sx={{ mr: 1, cursor: 'pointer', display: { xs: 'none', sm: 'flex' } }}
            />
          )}

          {/* Profile Menu */}
          <IconButton
            color="inherit"
            onClick={handleProfileMenuOpen}
          >
            {user?.picture ? (
              <Badge
                overlap="circular"
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                badgeContent={
                  user?.salesforce_connected 
                    ? <CloudIcon sx={{ fontSize: 12, color: 'success.main' }} />
                    : null
                }
              >
                <Avatar src={user.picture} sx={{ width: 28, height: 28 }} />
              </Badge>
            ) : (
              <Avatar sx={{ width: 32, height: 32, bgcolor: theme.palette.primary.main }}>
                {user?.name?.charAt(0) || <AccountCircleIcon />}
              </Avatar>
            )}
          </IconButton>
          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleProfileMenuClose}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'right',
            }}
            transformOrigin={{
              vertical: 'top',
              horizontal: 'right',
            }}
          >
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {user?.name || 'User'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {user?.email || 'No email'}
              </Typography>
              {user?.salesforce_connected ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                  <CloudIcon sx={{ fontSize: 14, color: 'success.main' }} />
                  <Typography variant="caption" color="success.main">
                    SF: {user.salesforce_user_name}
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                  <CloudOffIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                  <Typography variant="caption" color="warning.main">
                    Salesforce not connected
                  </Typography>
                </Box>
              )}
            </Box>
            <Divider />
            {!user?.salesforce_connected && (
              <MenuItem onClick={() => { handleProfileMenuClose(); connectSalesforce(); }}
                sx={{ color: 'primary.main' }}>
                <CloudIcon sx={{ mr: 1, fontSize: 18 }} />
                Connect Salesforce
              </MenuItem>
            )}
            <MenuItem onClick={() => { handleProfileMenuClose(); navigate('/settings'); }}>
              Settings
            </MenuItem>
            <MenuItem onClick={async () => { 
              handleProfileMenuClose(); 
              try {
                await apiService.clearCache();
                toast.success('Cache cleared — data will refresh');
              } catch { 
                toast.error('Failed to clear cache'); 
              }
            }}>
              Refresh Data
            </MenuItem>
            <MenuItem onClick={() => { handleProfileMenuClose(); logout(); }}>
              Logout
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        sx={{ width: { md: collapsedDrawerWidth }, flexShrink: { md: 0 } }}
      >
        {/* Mobile drawer */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{
            keepMounted: true, // Better open performance on mobile.
          }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': {
              boxSizing: 'border-box',
              width: drawerWidth,
            },
          }}
        >
          {drawer}
        </Drawer>

        {/* Desktop drawer */}
        <Drawer
          variant="permanent"
          onMouseEnter={() => setDrawerHovered(true)}
          onMouseLeave={() => setDrawerHovered(false)}
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              boxSizing: 'border-box',
              width: currentDrawerWidth,
              borderRight: '1px solid #e0e0e0',
              overflowX: 'hidden',
              transition: theme.transitions.create('width', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.enteringScreen,
              }),
              boxShadow: isExpanded ? '2px 0 8px rgba(0,0,0,0.15)' : 'none',
              zIndex: isExpanded ? 1200 : 'auto',
            },
          }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 2,
          pt: 1,
          width: { md: `calc(100% - ${collapsedDrawerWidth}px)` },
          minHeight: '100vh',
          backgroundColor: theme.palette.background.default,
        }}
      >
        <Toolbar sx={{ minHeight: '48px !important', height: 48 }} />
        <PlatformIdentityBanner />
        {/* Page identity header — single source of truth from ALL_MENU_ITEMS.
            Renders title + subtitle on every top-level page so users always
            know what page they're on and what it's for. Pages keep their own
            section-specific headers below (e.g. date ranges, project names). */}
        {currentMenuItem && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="h5" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
              {currentMenuItem.text}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {currentMenuItem.subtitle}
            </Typography>
          </Box>
        )}
        {children}
      </Box>

      {/* Notification overlays — TaskPanel drawer + edit dialogs */}
      <TaskPanel
        open={taskPanelOpen}
        onClose={handleCloseTaskPanel}
        opportunity={taskPanelOpp}
        selectedTaskId={selectedTaskId}
        orphanTask={orphanTask}
      />
      <OpportunityEditDialog
        open={!!editOppId}
        onClose={() => { setEditOppId(null); setEditOppData(undefined); }}
        opportunityId={editOppId}
        initialData={editOppData}
      />
      <AccountEditDialog
        open={!!editAccountId}
        onClose={() => { setEditAccountId(null); setEditAccountData(undefined); }}
        accountId={editAccountId}
        initialData={editAccountData}
      />
      <ContactEditDialog
        open={!!editContactId}
        onClose={() => { setEditContactId(null); setEditContactData(undefined); }}
        contactId={editContactId}
        initialData={editContactData}
      />
    </Box>
  );
};

export default Layout;

