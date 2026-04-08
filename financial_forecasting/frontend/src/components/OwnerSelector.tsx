import React, { useEffect, useMemo } from 'react';
import { Autocomplete, TextField, Chip } from '@mui/material';

export interface OwnerOption {
  id: string;
  name: string;
}

interface OwnerSelectorProps {
  availableOwners: OwnerOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** localStorage key suffix for persistence; pass undefined to skip persistence */
  storageKey?: string;
}

const STORAGE_KEY_PREFIX = 'walloprogress.selectedOwners.v1';

function loadStored(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}.${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    /* ignore corrupt data */
  }
  return null;
}

function writeStored(key: string, value: string[]) {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}.${key}`, JSON.stringify(value));
  } catch {
    /* storage full — ignore */
  }
}

/**
 * Multi-select Autocomplete for picking Opportunity Owners. Renders selected
 * owners as chips. Persists value to localStorage when `storageKey` is set.
 *
 * Filters the persisted value against currently available owners on every
 * render so dormant owners (no current open opps) drop out automatically.
 */
const OwnerSelector: React.FC<OwnerSelectorProps> = ({
  availableOwners,
  value,
  onChange,
  storageKey,
}) => {
  // Persist to localStorage on every change (when storageKey is provided)
  useEffect(() => {
    if (storageKey) {
      writeStored(storageKey, value);
    }
  }, [value, storageKey]);

  // Build a quick lookup so we can resolve string IDs → OwnerOption objects
  const idToOption = useMemo(() => {
    const map = new Map<string, OwnerOption>();
    for (const o of availableOwners) map.set(o.id, o);
    return map;
  }, [availableOwners]);

  // Filter the value to only IDs that are currently in availableOwners
  // (so a stored selection survives across renders even if some owners drop out)
  const visibleSelectedOptions = useMemo(
    () => value.map((id) => idToOption.get(id)).filter((o): o is OwnerOption => Boolean(o)),
    [value, idToOption],
  );

  return (
    <Autocomplete
      multiple
      options={availableOwners}
      value={visibleSelectedOptions}
      onChange={(_e, next) => onChange(next.map((o) => o.id))}
      getOptionLabel={(opt) => opt.name}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterSelectedOptions
      renderTags={(tagValue, getTagProps) =>
        tagValue.map((option, index) => {
          const tagProps = getTagProps({ index });
          return (
            <Chip
              {...tagProps}
              key={option.id}
              label={option.name}
              size="small"
            />
          );
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label="Filter by Opportunity Owner"
          placeholder={value.length === 0 ? 'Pick one or more owners…' : ''}
          size="small"
        />
      )}
      sx={{ width: '100%' }}
      ChipProps={{ size: 'small' }}
    />
  );
};

/**
 * Helper for parents that want to seed the initial selection from localStorage
 * (filtered to currently-available owner IDs). Returns null if no stored value.
 */
export function loadStoredOwnerSelection(
  storageKey: string,
  availableOwnerIds: Set<string>,
): string[] | null {
  const stored = loadStored(storageKey);
  if (!stored) return null;
  return stored.filter((id) => availableOwnerIds.has(id));
}

export default OwnerSelector;
