/**
 * <AmountCell> — dollar amount editor for Opportunity.Amount (and any other
 * currency fields classified under Opportunity/Target).
 *
 * Classified as `sensitive` — amount changes flow through weighted-pipeline
 * and forecasting rollups, so the primitive requires an unlock confirmation.
 */
import React, { useCallback } from 'react';
import { InlineEditable } from '../InlineEditable';
import { formatDollarMillions } from '../../../utils/formatters';

interface AmountCellProps {
  value: number | null;
  /** Save handler. The primitive's `validate` rejects null before save, so
   *  the handler will always receive a finite non-negative number in practice,
   *  but the type preserves `null` to match the primitive's value type. */
  onSave: (newAmount: number | null) => void | Promise<void>;
  fieldName?: string;
  objectType?: string;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const AmountCell: React.FC<AmountCellProps> = ({
  value,
  onSave,
  fieldName = 'Amount',
  objectType = 'Opportunity',
  recordLock,
  recordLockedByName,
  readOnly,
}) => {
  const formatDisplay = useCallback(
    (v: number | null) => (v == null ? '—' : formatDollarMillions(v)),
    [],
  );

  const validate = useCallback((v: number | null) => {
    if (v == null || Number.isNaN(v)) return 'Amount is required.';
    if (v < 0) return 'Amount cannot be negative.';
    if (v > 1_000_000_000) return 'Amount seems unrealistic. Double-check.';
    return null;
  }, []);

  return (
    <InlineEditable<number | null>
      objectType={objectType}
      fieldName={fieldName}
      fieldLabel="Amount"
      value={value}
      variant="number"
      onSave={onSave}
      formatDisplay={formatDisplay}
      validate={validate}
      placeholder="—"
      recordLock={recordLock}
      recordLockedByName={recordLockedByName}
      readOnly={readOnly}
    />
  );
};

export default AmountCell;
