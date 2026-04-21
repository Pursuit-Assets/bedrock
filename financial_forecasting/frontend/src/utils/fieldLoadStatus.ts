/**
 * Per-field load-status helper for edit dialogs.
 *
 * Edit dialogs load their initial record from the list-endpoint's react-query
 * cache. If the backend SOQL omits a field bound by the dialog, the field is
 * ABSENT from the original record — visually identical to a field whose value
 * in SF is null, and users can't tell the difference. Silent bugs have shipped
 * this way (RenewalRepeat__c fixed in PR #160; Contract/Payment/Billing and
 * Task.WhatId fixed in PR #162).
 *
 * This helper distinguishes three states at the dialog layer:
 *   - Field present in record + value → no helper text, display value
 *   - Field present in record + null/empty → "Not set" helper text
 *   - Field ABSENT from record (SOQL gap) → "⚠ Couldn't load current value"
 *
 * A matching save-time guard (`findMissingFields`) lets dialogs block save
 * when any expected field is absent, so users don't silently overwrite data
 * they can't see.
 */

export type FieldLoadState = 'loaded-value' | 'loaded-empty' | 'not-loaded';

export interface FieldLoadStatus {
  state: FieldLoadState;
  /** Helper text to render under the input. `undefined` when no caption is needed. */
  helperText: string | undefined;
  /** True when the field wasn't returned by the backend — render caption in warning color. */
  isWarning: boolean;
}

/**
 * Derive the load status of a single field.
 *
 * Pass the ORIGINAL record (as loaded from the API), not the in-progress
 * `editForm` state — a field the user just cleared in the UI is still
 * "loaded", not missing.
 */
export function getFieldLoadStatus(
  fieldName: string,
  originalRecord: Record<string, any> | null | undefined,
): FieldLoadStatus {
  // Before initial load, or when the record itself isn't available:
  // we can't distinguish states yet. Show no caption.
  if (!originalRecord) {
    return { state: 'loaded-value', helperText: undefined, isWarning: false };
  }

  if (!(fieldName in originalRecord)) {
    return {
      state: 'not-loaded',
      helperText: '⚠ Couldn\'t load current value',
      isWarning: true,
    };
  }

  const value = originalRecord[fieldName];
  // Treat null, undefined, and empty string as "no value stored".
  // (undefined shouldn't happen if the key is in the record, but be defensive.)
  if (value == null || value === '') {
    return { state: 'loaded-empty', helperText: 'Not set', isWarning: false };
  }

  return { state: 'loaded-value', helperText: undefined, isWarning: false };
}

/**
 * MUI `helperText` + `FormHelperTextProps` pair for a TextField.
 * Spread into the TextField like:
 *
 *   <TextField
 *     label="..."
 *     value={editForm.X || ''}
 *     onChange={...}
 *     {...fieldStatusProps('X', originalRecord)}
 *   />
 *
 * The warning-color style uses MUI's `warning.main` palette token so the
 * caption stands out without turning the entire input red (which would
 * suggest a validation error rather than a load failure).
 */
export function fieldStatusProps(
  fieldName: string,
  originalRecord: Record<string, any> | null | undefined,
): { helperText: string | undefined; FormHelperTextProps?: { sx: { color: string } } } {
  const status = getFieldLoadStatus(fieldName, originalRecord);
  if (!status.helperText) {
    return { helperText: undefined };
  }
  if (status.isWarning) {
    return {
      helperText: status.helperText,
      FormHelperTextProps: { sx: { color: 'warning.main' } },
    };
  }
  // "Not set" caption is neutral — no color override.
  return { helperText: status.helperText };
}

/**
 * Return the subset of expected fields that are NOT present on the original
 * record. Used by save handlers to block the save and prompt the user to
 * reload, so they don't overwrite unseen data.
 *
 * Pass only fields the dialog can actually SAVE (not read-only joined
 * relationships like Account.Name or Owner.Name).
 */
export function findMissingFields(
  expectedFields: readonly string[],
  originalRecord: Record<string, any> | null | undefined,
): string[] {
  if (!originalRecord) return [];
  return expectedFields.filter((f) => !(f in originalRecord));
}
