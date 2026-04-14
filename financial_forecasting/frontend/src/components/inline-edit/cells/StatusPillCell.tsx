/**
 * <StatusPillCell> — generic status pill editor for safe-classified status
 * fields (Milestone.status, Task.Status, etc.). Caller provides options +
 * the matching (objectType, fieldName) so the underlying primitive can
 * gate the right sensitivity classification.
 *
 * Use the more specific cells (e.g. <MilestoneStatusCell>) when the option
 * set is canonical; this generic cell is for cases where the options are
 * dynamic or context-dependent.
 */
import React from 'react';
import { InlineEditable, InlineEditableOption } from '../InlineEditable';

interface StatusPillCellProps {
  /** API field name used by the sensitivity classifier (e.g. 'status', 'Status'). */
  fieldName: string;
  /** Object type for the sensitivity classifier (e.g. 'Milestone', 'Task'). */
  objectType: string;
  /** Human-readable label shown in the unlock dialog. */
  fieldLabel?: string;
  value: string;
  options: InlineEditableOption[];
  onSave: (newValue: string) => void | Promise<void>;
  /** Optional record-level lock (e.g. task.opportunity lock). Forwarded to
   *  the primitive so a locked-by-other record is disabled without
   *  circumventing the sensitivity check. */
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const StatusPillCell: React.FC<StatusPillCellProps> = ({
  fieldName,
  objectType,
  fieldLabel,
  value,
  options,
  onSave,
  recordLock,
  recordLockedByName,
  readOnly,
}) => (
  <InlineEditable<string>
    objectType={objectType}
    fieldName={fieldName}
    fieldLabel={fieldLabel || fieldName}
    value={value}
    variant="select"
    display="pill"
    options={options}
    onSave={onSave}
    recordLock={recordLock}
    recordLockedByName={recordLockedByName}
    readOnly={readOnly}
  />
);

export default StatusPillCell;
