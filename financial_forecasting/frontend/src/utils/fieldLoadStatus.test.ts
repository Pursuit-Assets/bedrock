/**
 * Unit tests for the field-load-status helper.
 *
 * Pins three load states — loaded-with-value, loaded-empty, not-loaded —
 * and the save-time `findMissingFields` safety net. Each edit dialog
 * relies on this helper to distinguish "SF has no value" from "Bedrock
 * couldn't load the value".
 */
import {
  getFieldLoadStatus,
  fieldStatusProps,
  findMissingFields,
} from './fieldLoadStatus';

describe('getFieldLoadStatus', () => {
  it('returns loaded-value when field is present with a non-empty value', () => {
    const status = getFieldLoadStatus('Name', { Name: 'Ascendium' });
    expect(status.state).toBe('loaded-value');
    expect(status.helperText).toBeUndefined();
    expect(status.isWarning).toBe(false);
  });

  it('returns loaded-empty for explicit null', () => {
    const status = getFieldLoadStatus('RenewalRepeat__c', {
      RenewalRepeat__c: null,
    });
    expect(status.state).toBe('loaded-empty');
    expect(status.helperText).toBe('Not set');
    expect(status.isWarning).toBe(false);
  });

  it('returns loaded-empty for empty string', () => {
    const status = getFieldLoadStatus('Description', { Description: '' });
    expect(status.state).toBe('loaded-empty');
    expect(status.helperText).toBe('Not set');
  });

  it('returns not-loaded when field is absent from record', () => {
    const status = getFieldLoadStatus('Payment_Terms__c', {
      Name: 'Ascendium',
      // Payment_Terms__c intentionally omitted — SOQL gap
    });
    expect(status.state).toBe('not-loaded');
    expect(status.helperText).toBe("⚠ Couldn't load current value");
    expect(status.isWarning).toBe(true);
  });

  it('returns no caption when originalRecord is null (pre-load)', () => {
    // Before the dialog resolves its record, we can't distinguish —
    // treat as "nothing to flag yet".
    const status = getFieldLoadStatus('Name', null);
    expect(status.state).toBe('loaded-value');
    expect(status.helperText).toBeUndefined();
  });

  it('returns no caption when originalRecord is undefined (pre-load)', () => {
    const status = getFieldLoadStatus('Name', undefined);
    expect(status.state).toBe('loaded-value');
    expect(status.helperText).toBeUndefined();
  });

  it('distinguishes present-but-null from absent (the load-gap pattern)', () => {
    // Exactly the bug this helper catches: "Not set" vs "⚠ Couldn't load"
    // must be different when one field is null (user never set it) and
    // another is absent from SOQL response (Bedrock bug).
    const record = { RecordTypeId: null };
    const loadedEmpty = getFieldLoadStatus('RecordTypeId', record);
    const notLoaded = getFieldLoadStatus('RenewalRepeat__c', record);
    expect(loadedEmpty.helperText).toBe('Not set');
    expect(notLoaded.helperText).toBe("⚠ Couldn't load current value");
    expect(loadedEmpty.isWarning).toBe(false);
    expect(notLoaded.isWarning).toBe(true);
  });

  it('treats zero and boolean false as valid loaded values', () => {
    // Defensive: 0 and false are legit SF values, not "empty".
    expect(getFieldLoadStatus('Amount', { Amount: 0 }).state).toBe('loaded-value');
    expect(getFieldLoadStatus('Active__c', { Active__c: false }).state).toBe('loaded-value');
  });
});

describe('fieldStatusProps', () => {
  it('returns empty props when no caption needed', () => {
    const props = fieldStatusProps('Name', { Name: 'Ascendium' });
    expect(props.helperText).toBeUndefined();
    expect(props.FormHelperTextProps).toBeUndefined();
  });

  it('attaches warning-color sx for not-loaded fields', () => {
    const props = fieldStatusProps('Payment_Terms__c', { Name: 'Ascendium' });
    expect(props.helperText).toBe("⚠ Couldn't load current value");
    expect(props.FormHelperTextProps).toEqual({ sx: { color: 'warning.main' } });
  });

  it('leaves color default for loaded-empty ("Not set")', () => {
    const props = fieldStatusProps('Description', { Description: null });
    expect(props.helperText).toBe('Not set');
    expect(props.FormHelperTextProps).toBeUndefined();
  });
});

describe('findMissingFields', () => {
  it('returns empty array when all expected fields are present', () => {
    const missing = findMissingFields(
      ['Name', 'StageName', 'Amount'],
      { Name: 'X', StageName: 'Y', Amount: 100 },
    );
    expect(missing).toEqual([]);
  });

  it('returns empty array when all expected fields are present (even if null)', () => {
    // null is a valid "loaded" state — field was fetched, just has no value.
    const missing = findMissingFields(
      ['Name', 'Description'],
      { Name: 'X', Description: null },
    );
    expect(missing).toEqual([]);
  });

  it('returns the subset of expected fields that are absent from the record', () => {
    const missing = findMissingFields(
      ['Name', 'Contract_Start_Date__c', 'Payment_Terms__c', 'StageName'],
      { Name: 'X', StageName: 'Y' },
    );
    expect(missing).toEqual(['Contract_Start_Date__c', 'Payment_Terms__c']);
  });

  it('returns empty array when original record is null (no basis for comparison)', () => {
    // Pre-load state: don't block save in a state where nothing could be
    // loaded yet — other guards (like `!originalRecord`) handle that.
    const missing = findMissingFields(['Name'], null);
    expect(missing).toEqual([]);
  });

  it('returns empty array when original record is undefined', () => {
    const missing = findMissingFields(['Name'], undefined);
    expect(missing).toEqual([]);
  });

  it('preserves order of the expected fields input', () => {
    // SaveBlockedDialog renders fields in list order — keep the caller's
    // intent rather than alphabetizing.
    const missing = findMissingFields(
      ['Z_field', 'A_field', 'M_field'],
      { OtherField: 'X' },
    );
    expect(missing).toEqual(['Z_field', 'A_field', 'M_field']);
  });
});
