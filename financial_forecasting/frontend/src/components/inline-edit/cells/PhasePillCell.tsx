/**
 * <PhasePillCell> — milestone phase / priority editor (Now / Later /
 * On-going). Classified safe under Milestone.priority.
 *
 * The phase is shown as a pill in the milestone row and on Kanban cards,
 * matching Jac's screenshot. Click → menu picker.
 */
import React from 'react';
import { InlineEditable, InlineEditableOption } from '../InlineEditable';

const PHASE_COLOR: Record<string, string> = {
  'Now': '#1976d2',
  'Later': '#9e9e9e',
  'On-going': '#2e7d32',
};

const DEFAULT_OPTIONS: InlineEditableOption[] = [
  { value: 'Now', label: 'Now', color: PHASE_COLOR['Now'] },
  { value: 'Later', label: 'Later', color: PHASE_COLOR['Later'] },
  { value: 'On-going', label: 'On-going', color: PHASE_COLOR['On-going'] },
];

interface PhasePillCellProps {
  value: string;
  onSave: (newPhase: string) => void | Promise<void>;
  /** Override the default Now/Later/On-going options if the parent uses
   *  a different phase taxonomy. */
  options?: InlineEditableOption[];
  fieldName?: string;
  objectType?: string;
  /** Optional record-level lock (e.g. milestone.opportunity lock). Forwarded
   *  to the primitive so a locked-by-other record is disabled without
   *  circumventing the sensitivity check. */
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const PhasePillCell: React.FC<PhasePillCellProps> = ({
  value,
  onSave,
  options,
  fieldName = 'priority',
  objectType = 'Milestone',
  recordLock,
  recordLockedByName,
  readOnly,
}) => (
  <InlineEditable<string>
    objectType={objectType}
    fieldName={fieldName}
    fieldLabel="Phase"
    value={value}
    variant="select"
    display="pill"
    options={options || DEFAULT_OPTIONS}
    onSave={onSave}
    pillColor={(v) => PHASE_COLOR[v as string]}
    placeholder="—"
    recordLock={recordLock}
    recordLockedByName={recordLockedByName}
    readOnly={readOnly}
  />
);

export default PhasePillCell;
