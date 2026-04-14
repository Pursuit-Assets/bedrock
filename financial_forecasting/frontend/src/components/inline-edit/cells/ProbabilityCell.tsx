/**
 * <ProbabilityCell> — Opportunity probability editor (0-100). Classified
 * sensitive — affects weighted-pipeline rollups, so the primitive
 * requires an unlock confirmation.
 *
 * Note: in Salesforce, Probability is normally auto-calculated from
 * StageName via the standard process. Manual edits override the auto
 * value until the next stage change. Use sparingly.
 */
import React, { useCallback } from 'react';
import { InlineEditable } from '../InlineEditable';

interface ProbabilityCellProps {
  value: number | null;
  onSave: (newProbability: number | null) => void | Promise<void>;
  fieldName?: string;
  objectType?: string;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const ProbabilityCell: React.FC<ProbabilityCellProps> = ({
  value,
  onSave,
  fieldName = 'Probability',
  objectType = 'Opportunity',
  recordLock,
  recordLockedByName,
  readOnly,
}) => {
  const formatDisplay = useCallback(
    (v: number | null) => (v == null ? '—' : `${v}%`),
    [],
  );

  const validate = useCallback((v: number | null) => {
    if (v == null || Number.isNaN(v)) return 'Probability is required.';
    if (v < 0 || v > 100) return 'Probability must be between 0 and 100.';
    return null;
  }, []);

  return (
    <InlineEditable<number | null>
      objectType={objectType}
      fieldName={fieldName}
      fieldLabel="Probability"
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

export default ProbabilityCell;
