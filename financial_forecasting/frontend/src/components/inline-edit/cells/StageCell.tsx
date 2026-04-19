/**
 * <StageCell> — Opportunity stage editor. Wraps <InlineEditable> with the
 * canonical stage list + per-stage color palette, and declares the
 * Opportunity.StageName classification (sensitive — affects pipeline metrics).
 *
 * Used by Reports columns and any other surface that edits opportunity stage.
 */
import React from 'react';
import {
  InlineEditable,
  InlineEditableOption,
} from '../InlineEditable';
import {
  OPPORTUNITY_STAGES,
  getStageHexColor,
} from '../../../types/salesforce';

const STAGE_OPTIONS: InlineEditableOption[] = OPPORTUNITY_STAGES.map((stage) => ({
  value: stage,
  label: stage,
  color: getStageHexColor(stage),
}));

interface StageCellProps {
  value: string;
  onSave: (newValue: string) => void | Promise<void>;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const StageCell: React.FC<StageCellProps> = ({
  value,
  onSave,
  recordLock,
  recordLockedByName,
  readOnly,
}) => (
  <InlineEditable<string>
    objectType="Opportunity"
    fieldName="StageName"
    fieldLabel="Stage"
    value={value}
    variant="select"
    display="pill"
    options={STAGE_OPTIONS}
    onSave={onSave}
    pillColor={(v) => getStageHexColor(v as string)}
    recordLock={recordLock}
    recordLockedByName={recordLockedByName}
    readOnly={readOnly}
  />
);

export default StageCell;
