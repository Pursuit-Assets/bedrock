import React, { useState, useMemo, useEffect } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  IconButton,
  Button,
  Tooltip,
} from '@mui/material';
import {
  ChevronRight as ExpandIcon,
  FileUpload as ImportIcon,
} from '@mui/icons-material';
import type { ViewType, FilterState } from '../components/projects/types';
import { useProjectData } from '../components/projects/useProjectData';
import { useProjects } from '../components/projects/useProjects';
import { applyFilters } from '../components/projects/helpers';
import { AIJI_PROJECT_ID } from '../components/projects/constants';
import ViewSwitcher from '../components/projects/ViewSwitcher';
import FilterBar from '../components/projects/FilterBar';
import ListView from '../components/projects/ListView';
import ExecutiveSnapshot from '../components/projects/ExecutiveSnapshot';
import KanbanBoard from '../components/projects/KanbanBoard';
import GanttChart from '../components/projects/GanttChart';
import ProjectSidebar from '../components/projects/ProjectSidebar';
import ImportCsvDialog from '../components/projects/ImportCsvDialog';
import LinkedOpportunities from '../components/projects/LinkedOpportunities';
import ProjectTeam from '../components/projects/ProjectTeam';

const PREFS_KEY = 'pursuit-projects-prefs';

interface ProjectPrefs {
  viewType: ViewType;
  selectedProjectId: string | null;
  sidebarCollapsed: boolean;
}

function loadPrefs(): ProjectPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...{ viewType: 'list', selectedProjectId: null, sidebarCollapsed: true }, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { viewType: 'list', selectedProjectId: null, sidebarCollapsed: true };
}

const Projects: React.FC = () => {
  const [prefs, setPrefs] = useState<ProjectPrefs>(loadPrefs);
  const [filters, setFilters] = useState<FilterState>({ workstreams: [], owners: [] });
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    const legacyView = localStorage.getItem('pursuit-projects-view') as ViewType;
    if (legacyView && !localStorage.getItem(PREFS_KEY)) {
      setPrefs((p) => ({ ...p, viewType: legacyView }));
      localStorage.removeItem('pursuit-projects-view');
    }
  }, []);

  const {
    projects, isLoading: projectsLoading, createProject, deleteProject,
    deletedProjects, restoreProject, purgeProject,
    addContributor, removeContributor, transferOwnership,
  } = useProjects();

  useEffect(() => {
    if (projects.length === 0) {
      // Clear stale selectedProjectId when there are no projects,
      // so useProjectData doesn't try to fetch a non-existent project.
      setPrefs((p) => p.selectedProjectId ? { ...p, selectedProjectId: null } : p);
      return;
    }
    // Use functional updater to read the latest selectedProjectId,
    // and only depend on [projects] to avoid a race condition where
    // a newly-created project's selection is overridden before the
    // projects list has refreshed.
    setPrefs((p) => {
      const currentValid = p.selectedProjectId && projects.some((proj) => proj.id === p.selectedProjectId);
      if (!currentValid) {
        const aiji = projects.find((proj) => proj.id === AIJI_PROJECT_ID);
        return { ...p, selectedProjectId: aiji?.id || projects[0].id };
      }
      return p;
    });
  }, [projects]);

  const {
    workstreams, projectName, ownerEmail, contributors,
    isLoading: dataLoading, error, mutations, invalidate,
  } = useProjectData(prefs.selectedProjectId);

  const filtered = useMemo(
    () => applyFilters(workstreams, filters),
    [workstreams, filters]
  );

  const isLoading = projectsLoading || dataLoading;
  const { viewType } = prefs;
  const setViewType = (v: ViewType) => setPrefs((p) => ({ ...p, viewType: v }));

  if (isLoading && !workstreams.length) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    const axiosError = error as any;
    const detail = axiosError?.response?.data?.detail
      || axiosError?.message
      || 'Failed to load project data. Make sure the backend is running.';
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {detail}
      </Alert>
    );
  }

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 80px)' }}>
      {!prefs.sidebarCollapsed && (
        <ProjectSidebar
          projects={projects}
          selectedId={prefs.selectedProjectId}
          onSelect={(id: string) => {
            setPrefs((p) => ({ ...p, selectedProjectId: id }));
            setFilters({ workstreams: [], owners: [] });
          }}
          onCreateProject={createProject}
          onDeleteProject={(id: string) => {
            deleteProject(id);
            const remaining = projects.filter((p) => p.id !== id);
            if (remaining.length > 0 && prefs.selectedProjectId === id) {
              setPrefs((p) => ({ ...p, selectedProjectId: remaining[0].id }));
            }
          }}
          onCollapse={() => setPrefs((p) => ({ ...p, sidebarCollapsed: true }))}
          deletedProjects={deletedProjects}
          onRestoreProject={restoreProject}
          onPurgeProject={purgeProject}
        />
      )}

      <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {prefs.sidebarCollapsed && (
                <Tooltip title="Show projects">
                  <IconButton size="small" onClick={() => setPrefs((p) => ({ ...p, sidebarCollapsed: false }))}>
                    <ExpandIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {/* Only show the project name here; the toolbar already shows
                  "Projects" as the page title so the generic fallback would
                  duplicate it (PR126-5). */}
              {projectName && (
                <Typography variant="h5" fontWeight={700}>
                  {projectName}
                </Typography>
              )}
              {projects.length > 1 && prefs.sidebarCollapsed && (
                <Typography variant="caption" color="text.secondary">
                  ({projects.length} projects)
                </Typography>
              )}
            </Box>

            {prefs.selectedProjectId && (
              <Box sx={{ mt: 0.5 }}>
                <LinkedOpportunities projectId={prefs.selectedProjectId} />
              </Box>
            )}
            {prefs.selectedProjectId && (ownerEmail || contributors.length > 0) && (
              <ProjectTeam
                projectId={prefs.selectedProjectId}
                ownerEmail={ownerEmail}
                contributors={contributors}
                onAddContributor={addContributor}
                onRemoveContributor={removeContributor}
                onTransferOwnership={transferOwnership}
              />
            )}
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ImportIcon />}
              onClick={() => setImportOpen(true)}
              sx={{ textTransform: 'none', fontSize: '0.75rem' }}
            >
              Import CSV
            </Button>
            <ViewSwitcher value={viewType} onChange={setViewType} />
          </Box>
        </Box>

        {viewType !== 'executive' && (
          <FilterBar
            workstreams={workstreams}
            filters={filters}
            onFiltersChange={setFilters}
            viewType={viewType}
          />
        )}

        {viewType === 'list' && filtered.map((ws) => (
          <ListView key={ws.id} workstream={ws} mutations={mutations} />
        ))}

        {viewType === 'board' && (
          <KanbanBoard workstreams={filtered} mutations={mutations} />
        )}

        {viewType === 'timeline' && (
          <GanttChart workstreams={filtered} mutations={mutations} />
        )}

        {viewType === 'executive' && (
          <ExecutiveSnapshot workstreams={workstreams} />
        )}

        {viewType === 'list' && filtered.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
            {workstreams.length === 0
              ? 'No data yet. Import a CSV to get started.'
              : 'No workstreams match the current filters.'}
          </Typography>
        )}
      </Box>

      {prefs.selectedProjectId && (
        <ImportCsvDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          projectId={prefs.selectedProjectId}
          existingWorkstreams={workstreams}
          onImportComplete={invalidate}
        />
      )}
    </Box>
  );
};

export default Projects;
