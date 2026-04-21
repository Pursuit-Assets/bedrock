/**
 * <TypeCell> — Opportunity Type inline editor. Wraps <InlineEditable> with
 * the dynamic SF `Opportunity.Type` picklist (fetched via
 * useOpportunityTypePicklist) and declares the Opportunity.Type
 * classification (non-sensitive — categorization field, not a revenue gate).
 *
 * Options are supplied as a prop from the parent component so a single
 * picklist fetch feeds every row in the grid. When options are empty
 * (fetch failed or still loading), the cell renders read-only plain text.
 *
 * Mirrors the StageCell pattern in the sibling file for consistency.
 */
import React from 'react';
import { Box } from '@mui/material';
import {
  InlineEditable,
  InlineEditableOption,
} from '../InlineEditable';

interface TypeCellProps {
  value: string | null;
  options: string[];
  onSave: (newValue: string) => void | Promise<void>;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

// Neutral pill color — Opportunity.Type is categorical but doesn't carry
// the same semantic weight as Stage (Stage encodes pipeline progression, so
// it uses a green→maroon palette; Type is just a subtype, so we keep it
// subdued to avoid visual competition with the Stage column).
const TYPE_PILL_COLOR = '#78909c'; // MUI blueGrey 400 — matches neutral chip.

export const TypeCell: React.FC<TypeCellProps> = ({
  value,
  options,
  onSave,
  recordLock,
  recordLockedByName,
  readOnly,
}) => {
  // If options aren't ready (picklist fetch failed or still in flight), fall
  // back to a read-only display so the grid still shows the current value.
  // This preserves graceful degradation under schema-endpoint failure.
  if (options.length === 0) {
    return (
      <Box component="span" sx={{ color: value ? 'text.primary' : 'text.disabled' }}>
        {value || '—'}
      </Box>
    );
  }

  const pickOptions: InlineEditableOption[] = options.map((opt) => ({
    value: opt,
    label: opt,
    color: TYPE_PILL_COLOR,
  }));

  return (
    <InlineEditable<string>
      objectType="Opportunity"
      fieldName="Type"
      fieldLabel="Type"
      value={value ?? ''}
      variant="select"
      display="pill"
      options={pickOptions}
      onSave={onSave}
      pillColor={() => TYPE_PILL_COLOR}
      placeholder="—"
      recordLock={recordLock}
      recordLockedByName={recordLockedByName}
      readOnly={readOnly}
    />
  );
};

export default TypeCell;
