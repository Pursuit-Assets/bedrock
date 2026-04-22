import React from 'react';
import {
  Box, FormControl, InputLabel, Select, MenuItem, Chip, OutlinedInput,
  SelectChangeEvent,
} from '@mui/material';
import type { ActiveUser, Workstream, FilterState, ViewType } from './types';
import { useActiveUsers } from './useActiveUsers';

interface FilterBarProps {
  workstreams: Workstream[];
  filters: FilterState;
  onFiltersChange: (f: FilterState) => void;
  viewType: ViewType;
}

const FilterBar: React.FC<FilterBarProps> = ({ workstreams, filters, onFiltersChange, viewType }) => {
  const { activeUsers } = useActiveUsers();

  if (viewType === 'executive') return null;

  const nameById = new Map(activeUsers.map((u: ActiveUser) => [u.id, u.display_name]));

  const handleWorkstreamChange = (e: SelectChangeEvent<string[]>) => {
    const val = e.target.value;
    onFiltersChange({ ...filters, workstreams: typeof val === 'string' ? val.split(',') : val });
  };

  const handleOwnerChange = (e: SelectChangeEvent<string[]>) => {
    const val = e.target.value;
    onFiltersChange({ ...filters, owners: typeof val === 'string' ? val.split(',') : val });
  };

  const setQuickFilter = (wsId: string) => {
    if (filters.workstreams.length === 1 && filters.workstreams[0] === wsId) {
      onFiltersChange({ ...filters, workstreams: [] });
    } else {
      onFiltersChange({ ...filters, workstreams: [wsId] });
    }
  };

  return (
    <Box sx={{ display: 'flex', gap: 1.5, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
      <FormControl size="small" sx={{ minWidth: 180 }}>
        <InputLabel sx={{ fontSize: '0.8rem' }}>Workstreams</InputLabel>
        <Select
          multiple
          value={filters.workstreams}
          onChange={handleWorkstreamChange}
          input={<OutlinedInput label="Workstreams" />}
          renderValue={(selected) => (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }}>
              {selected.map(id => {
                const ws = workstreams.find(w => w.id === id);
                return <Chip key={id} label={ws?.name || id} size="small" sx={{ fontSize: '0.65rem', height: 18 }} />;
              })}
            </Box>
          )}
          sx={{ '& .MuiSelect-select': { py: 0.75 } }}
        >
          {workstreams.map(ws => (
            <MenuItem key={ws.id} value={ws.id} sx={{ fontSize: '0.8rem' }}>{ws.name}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 180 }}>
        <InputLabel sx={{ fontSize: '0.8rem' }}>Owners</InputLabel>
        <Select
          multiple
          value={filters.owners}
          onChange={handleOwnerChange}
          input={<OutlinedInput label="Owners" />}
          renderValue={(selected) => (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }}>
              {selected.map(id => (
                <Chip
                  key={id}
                  label={nameById.get(id) || id}
                  size="small"
                  sx={{ fontSize: '0.65rem', height: 18 }}
                />
              ))}
            </Box>
          )}
          sx={{ '& .MuiSelect-select': { py: 0.75 } }}
        >
          {activeUsers.map((u: ActiveUser) => (
            <MenuItem key={u.id} value={u.id} sx={{ fontSize: '0.8rem' }}>
              {u.display_name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {workstreams.slice(0, 3).map((ws) => (
        <Chip
          key={ws.id}
          label={ws.name}
          size="small"
          variant={filters.workstreams.includes(ws.id) ? 'filled' : 'outlined'}
          color={filters.workstreams.includes(ws.id) ? 'primary' : 'default'}
          onClick={() => setQuickFilter(ws.id)}
          sx={{ fontSize: '0.7rem' }}
        />
      ))}

      {(filters.workstreams.length > 0 || filters.owners.length > 0) && (
        <Chip
          label="Clear"
          size="small"
          onDelete={() => onFiltersChange({ workstreams: [], owners: [] })}
          sx={{ fontSize: '0.7rem' }}
        />
      )}
    </Box>
  );
};

export default FilterBar;
