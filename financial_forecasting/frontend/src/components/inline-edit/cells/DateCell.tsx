/**
 * <DateCell> — date editor with safe-with-bounds validation.
 *
 * Used for CloseDate / Due date / ActivityDate. Classified safe in the
 * sensitivity table (no unlock confirmation), but the primitive's
 * `validate` rejects pre-1970 and >10-year-out dates as a sanity guard.
 */
import React, { useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import { InlineEditable } from '../InlineEditable';
import { validateDateBounds } from '../../../utils/fieldSensitivity';

interface DateCellProps {
  /** ISO date string (yyyy-MM-dd) or empty string when unset. */
  value: string;
  onSave: (newDate: string) => void | Promise<void>;
  fieldName?: string;
  objectType?: string;
  /** Display format string. Defaults to 'MMM d, yyyy'. */
  displayFormat?: string;
  /** Override the rendered display element (e.g. for color-on-overdue). */
  renderDisplay?: (formatted: string, value: string) => React.ReactNode;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const DateCell: React.FC<DateCellProps> = ({
  value,
  onSave,
  fieldName = 'CloseDate',
  objectType = 'Opportunity',
  displayFormat = 'MMM d, yyyy',
  renderDisplay,
  recordLock,
  recordLockedByName,
  readOnly,
}) => {
  const formatDisplay = useCallback(
    (v: string) => {
      if (!v) return '—';
      try {
        const formatted = format(parseISO(v), displayFormat);
        return renderDisplay ? renderDisplay(formatted, v) : formatted;
      } catch {
        return v;
      }
    },
    [displayFormat, renderDisplay],
  );

  const validate = useCallback((v: string) => {
    if (!v) return null; // empty is OK — user clearing the field
    return validateDateBounds(v);
  }, []);

  return (
    <InlineEditable<string>
      objectType={objectType}
      fieldName={fieldName}
      fieldLabel="Date"
      value={value}
      variant="date"
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

export default DateCell;
