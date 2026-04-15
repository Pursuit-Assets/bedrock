import React, { useState, useRef, useEffect } from 'react';
import {
  FormControl,
  Select,
  MenuItem,
  Popover,
  Box,
  Button,
  Typography,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { format, parseISO, subDays } from 'date-fns';

export type LookbackPreset = 'last7d' | 'last30d' | 'last60d' | 'last90d' | 'custom';

export type LookbackValue =
  | { preset: Exclude<LookbackPreset, 'custom'> }
  | { preset: 'custom'; start: string; end: string };

const PRESET_LABELS: Record<Exclude<LookbackPreset, 'custom'>, string> = {
  last7d: 'Last 7 days',
  last30d: 'Last 30 days',
  last60d: 'Last 60 days',
  last90d: 'Last 90 days',
};

const PRESET_DAYS: Record<Exclude<LookbackPreset, 'custom'>, number> = {
  last7d: 7,
  last30d: 30,
  last60d: 60,
  last90d: 90,
};

// Salesforce's LAST_N_DAYS:n is "UTC midnight n days ago through the current
// second." Match that semantic on the client so the overlay filter agrees
// with what the backend returned, regardless of the user's local timezone.
function utcMidnightDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 0, 0, 0, 0),
  );
}

/** Resolve a LookbackValue to a concrete [start, end] Date range.
 *  For presets, start = UTC midnight N days ago, end = now (matches SF LAST_N_DAYS).
 *  For custom, start = UTC 00:00 on the start date, end = UTC 23:59:59.999 on the end date
 *  (matches the backend SOQL CreatedDate >= startT00:00:00Z AND <= endT23:59:59Z). */
export function resolveLookbackRange(value: LookbackValue): { start: Date; end: Date } {
  if (value.preset === 'custom') {
    return {
      start: new Date(`${value.start}T00:00:00.000Z`),
      end: new Date(`${value.end}T23:59:59.999Z`),
    };
  }
  return {
    start: utcMidnightDaysAgo(PRESET_DAYS[value.preset]),
    end: new Date(),
  };
}

/** Days integer to send to /stage-history (the endpoint only accepts days, 1..365).
 *  For presets, returns the preset's days so we hit the existing cache.
 *  For custom, returns ceil(days-from-today-to-start), clamped to [1, 365] — this
 *  becomes a superset window; the overlay is client-filtered to the exact range. */
export function lookbackToDays(value: LookbackValue): number {
  if (value.preset !== 'custom') {
    return PRESET_DAYS[value.preset];
  }
  const start = new Date(`${value.start}T00:00:00.000Z`);
  const ms = Date.now() - start.getTime();
  const days = Math.ceil(ms / 86_400_000);
  return Math.max(1, Math.min(365, days));
}

/** Human-readable label for the current lookback — used in tooltips and copy. */
export function formatLookbackLabel(value: LookbackValue): string {
  if (value.preset === 'custom') {
    try {
      return `between ${format(parseISO(value.start), 'MMM d')} and ${format(
        parseISO(value.end),
        'MMM d, yyyy',
      )}`;
    } catch {
      return 'in the selected range';
    }
  }
  return `in the ${PRESET_LABELS[value.preset].toLowerCase()}`;
}

interface LookbackRangeSelectorProps {
  value: LookbackValue;
  onChange: (value: LookbackValue) => void;
}

const LookbackRangeSelector: React.FC<LookbackRangeSelectorProps> = ({ value, onChange }) => {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [customStart, setCustomStart] = useState<Date | null>(null);
  const [customEnd, setCustomEnd] = useState<Date | null>(null);

  useEffect(() => {
    if (value.preset === 'custom') {
      try {
        setCustomStart(parseISO(value.start));
        setCustomEnd(parseISO(value.end));
      } catch {
        /* ignore malformed persisted value */
      }
    }
  }, [value]);

  const displayText = (() => {
    if (value.preset === 'custom') {
      try {
        return `${format(parseISO(value.start), 'MMM d')} – ${format(
          parseISO(value.end),
          'MMM d, yyyy',
        )}`;
      } catch {
        return 'Custom…';
      }
    }
    return PRESET_LABELS[value.preset] || 'Lookback';
  })();

  const today = new Date();
  const minDate = subDays(today, 365);

  const handleSelectChange = (newValue: string) => {
    if (newValue === 'custom') {
      if (!customStart) setCustomStart(subDays(today, 30));
      if (!customEnd) setCustomEnd(today);
      setPopoverOpen(true);
    } else {
      onChange({ preset: newValue as Exclude<LookbackPreset, 'custom'> });
    }
  };

  const canApply =
    !!customStart &&
    !!customEnd &&
    customStart.getTime() <= customEnd.getTime() &&
    customStart.getTime() >= minDate.getTime() &&
    customEnd.getTime() <= today.getTime();

  const handleApply = () => {
    if (canApply && customStart && customEnd) {
      onChange({
        preset: 'custom',
        start: format(customStart, 'yyyy-MM-dd'),
        end: format(customEnd, 'yyyy-MM-dd'),
      });
    }
    setPopoverOpen(false);
  };

  return (
    <>
      <FormControl
        size="small"
        sx={{
          minWidth: 130,
          '& .MuiInputBase-root': { height: 32, fontSize: '0.75rem' },
          '& .MuiInputLabel-root': { fontSize: '0.75rem' },
        }}
        ref={anchorRef}
      >
        <Select
          value={value.preset}
          onChange={(e) => handleSelectChange(e.target.value)}
          renderValue={() => displayText}
          size="small"
        >
          {Object.entries(PRESET_LABELS).map(([key, label]) => (
            <MenuItem key={key} value={key}>
              {label}
            </MenuItem>
          ))}
          <MenuItem value="custom" onClick={() => setPopoverOpen(true)}>
            Custom…
          </MenuItem>
        </Select>
      </FormControl>

      <Popover
        open={popoverOpen}
        anchorEl={anchorRef.current}
        onClose={() => setPopoverOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 280 }}>
          <Typography variant="subtitle2">Custom Lookback Range</Typography>
          <DatePicker
            label="From"
            value={customStart}
            onChange={setCustomStart}
            minDate={minDate}
            maxDate={today}
            slotProps={{ textField: { size: 'small', fullWidth: true } }}
          />
          <DatePicker
            label="To"
            value={customEnd}
            onChange={setCustomEnd}
            minDate={minDate}
            maxDate={today}
            slotProps={{ textField: { size: 'small', fullWidth: true } }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button
              size="small"
              onClick={() => {
                setPopoverOpen(false);
                onChange({ preset: 'last30d' });
              }}
            >
              Back to presets
            </Button>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" onClick={() => setPopoverOpen(false)}>
                Cancel
              </Button>
              <Button size="small" variant="contained" onClick={handleApply} disabled={!canApply}>
                Apply
              </Button>
            </Box>
          </Box>
        </Box>
      </Popover>
    </>
  );
};

export default LookbackRangeSelector;
