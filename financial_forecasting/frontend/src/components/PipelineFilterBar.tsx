import React, { useState, useMemo } from 'react';
import {
  Box,
  Chip,
  TextField,
  Autocomplete,
  Typography,
  Button,
  Slider,
  IconButton,
  Collapse,
  Paper,
} from '@mui/material';
import {
  FilterList as FilterIcon,
  Close as CloseIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
} from '@mui/icons-material';
import { OPPORTUNITY_STAGES, OPEN_STAGES, getStageHexColor } from '../types/salesforce';

export interface PipelineFilters {
  owners: string[];
  stages: string[];
  revenueStreams: string[];
  amountRange: [number, number];
  closeDateStart: string;
  closeDateEnd: string;
  aijiOnly: boolean;
  staleOnly: boolean;
}

export const DEFAULT_FILTERS: PipelineFilters = {
  owners: [],
  stages: [],
  revenueStreams: [],
  amountRange: [0, 50000000],
  closeDateStart: '',
  closeDateEnd: '',
  aijiOnly: false,
  staleOnly: false,
};

interface PipelineFilterBarProps {
  filters: PipelineFilters;
  onChange: (filters: PipelineFilters) => void;
  ownerOptions: Array<{ id: string; name: string; isActive?: boolean }>;
  stageOptions?: string[];
  revenueStreamOptions?: string[];
  initialExpanded?: boolean;
}

const PipelineFilterBar: React.FC<PipelineFilterBarProps> = ({
  filters,
  onChange,
  ownerOptions,
  stageOptions = OPPORTUNITY_STAGES as unknown as string[],
  revenueStreamOptions = [],
  initialExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(initialExpanded);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.owners.length) count++;
    if (filters.stages.length) count++;
    if (filters.revenueStreams.length) count++;
    if (filters.amountRange[0] > 0 || filters.amountRange[1] < 50000000) count++;
    if (filters.closeDateStart || filters.closeDateEnd) count++;
    if (filters.aijiOnly) count++;
    if (filters.staleOnly) count++;
    return count;
  }, [filters]);

  const clearAll = () => onChange(DEFAULT_FILTERS);

  const update = (patch: Partial<PipelineFilters>) => onChange({ ...filters, ...patch });

  return (
    <Paper variant="outlined" sx={{ mb: 2, p: 1.5 }}>
      {/* Top row: quick toggles + expand */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <FilterIcon fontSize="small" color="action" />
        <Typography variant="body2" fontWeight={600} sx={{ mr: 1 }}>
          Filters
          {activeFilterCount > 0 && (
            <Chip label={activeFilterCount} size="small" color="primary" sx={{ ml: 0.5, height: 20 }} />
          )}
        </Typography>

        {/* Quick toggles */}
        <Chip
          label="AIJI"
          size="small"
          color={filters.aijiOnly ? 'info' : 'default'}
          variant={filters.aijiOnly ? 'filled' : 'outlined'}
          onClick={() => update({ aijiOnly: !filters.aijiOnly })}
        />
        <Chip
          label="Stale (30d+)"
          size="small"
          color={filters.staleOnly ? 'warning' : 'default'}
          variant={filters.staleOnly ? 'filled' : 'outlined'}
          onClick={() => update({ staleOnly: !filters.staleOnly })}
        />

        {/* Active filter chips */}
        {filters.owners.length > 0 && (
          <Chip
            label={`Owner: ${filters.owners.length}`}
            size="small"
            onDelete={() => update({ owners: [] })}
          />
        )}
        {filters.stages.length > 0 && (
          <Chip
            label={`Stage: ${filters.stages.length}`}
            size="small"
            onDelete={() => update({ stages: [] })}
          />
        )}
        {(filters.closeDateStart || filters.closeDateEnd) && (
          <Chip
            label={`Date: ${filters.closeDateStart || '...'} — ${filters.closeDateEnd || '...'}`}
            size="small"
            onDelete={() => update({ closeDateStart: '', closeDateEnd: '' })}
          />
        )}

        <Box sx={{ flex: 1 }} />

        {activeFilterCount > 0 && (
          <Button size="small" onClick={clearAll} startIcon={<CloseIcon />}>
            Clear
          </Button>
        )}
        <IconButton size="small" onClick={() => setExpanded(!expanded)}>
          {expanded ? <CollapseIcon /> : <ExpandIcon />}
        </IconButton>
      </Box>

      {/* Expanded filters */}
      <Collapse in={expanded}>
        <Box sx={{ display: 'flex', gap: 2, mt: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Autocomplete
            multiple
            size="small"
            options={[...ownerOptions].sort((a, b) => {
              const aActive = a.isActive !== false ? 0 : 1;
              const bActive = b.isActive !== false ? 0 : 1;
              return aActive !== bActive ? aActive - bActive : a.name.localeCompare(b.name);
            })}
            groupBy={(opt) => opt.isActive === false ? 'Inactive' : 'Active'}
            getOptionLabel={(opt) => opt.name}
            value={ownerOptions.filter((o) => filters.owners.includes(o.id))}
            onChange={(_, vals) => update({ owners: vals.map((v) => v.id) })}
            renderInput={(params) => <TextField {...params} label="Owner" />}
            sx={{ minWidth: 200 }}
            disableCloseOnSelect
          />

          <Autocomplete
            multiple
            size="small"
            options={stageOptions}
            value={filters.stages}
            onChange={(_, vals) => update({ stages: vals })}
            renderInput={(params) => <TextField {...params} label="Stage" />}
            renderOption={(props, option) => (
              <li {...props}>
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: getStageHexColor(option), mr: 1, flexShrink: 0 }} />
                {option}
              </li>
            )}
            sx={{ minWidth: 200 }}
            disableCloseOnSelect
          />

          {revenueStreamOptions.length > 0 && (
            <Autocomplete
              multiple
              size="small"
              options={revenueStreamOptions}
              value={filters.revenueStreams}
              onChange={(_, vals) => update({ revenueStreams: vals })}
              renderInput={(params) => <TextField {...params} label="Revenue Stream" />}
              sx={{ minWidth: 200 }}
              disableCloseOnSelect
            />
          )}

          <TextField
            label="Close Date From"
            type="date"
            size="small"
            value={filters.closeDateStart}
            onChange={(e) => update({ closeDateStart: e.target.value })}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 160 }}
          />
          <TextField
            label="Close Date To"
            type="date"
            size="small"
            value={filters.closeDateEnd}
            onChange={(e) => update({ closeDateEnd: e.target.value })}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 160 }}
          />

          <Box sx={{ minWidth: 200 }}>
            <Typography variant="caption" color="text.secondary">
              Amount Range
            </Typography>
            <Slider
              size="small"
              value={filters.amountRange}
              onChange={(_, val) => update({ amountRange: val as [number, number] })}
              min={0}
              max={50000000}
              step={100000}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) =>
                v >= 1000000
                  ? `$${(v / 1000000).toFixed(1)}M`
                  : `$${(v / 1000).toFixed(0)}K`
              }
            />
          </Box>
        </Box>
      </Collapse>
    </Paper>
  );
};

export default PipelineFilterBar;
