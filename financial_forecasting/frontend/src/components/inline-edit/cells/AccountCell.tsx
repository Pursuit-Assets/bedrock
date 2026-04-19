/**
 * <AccountCell> — Account lookup/assignment editor for Opportunity /
 * Contact / related records.
 *
 * Classified as `sensitive` — changing the account link can cascade into
 * commission rollups, so the primitive requires an unlock confirmation.
 */
import React, { useMemo } from 'react';
import { InlineEditable, InlineEditableOption } from '../InlineEditable';

interface Account {
  Id: string;
  Name: string;
}

interface AccountCellProps {
  value: string;
  accounts: Account[];
  fieldName?: string;
  objectType?: string;
  onSave: (newAccountId: string) => void | Promise<void>;
  recordLock?: { locked_by: string; locked_at: string } | null;
  recordLockedByName?: string | null;
  readOnly?: boolean;
}

export const AccountCell: React.FC<AccountCellProps> = ({
  value,
  accounts,
  fieldName = 'AccountId',
  objectType = 'Opportunity',
  onSave,
  recordLock,
  recordLockedByName,
  readOnly,
}) => {
  const options: InlineEditableOption[] = useMemo(
    () =>
      [...accounts]
        .sort((a, b) => (a.Name || '').localeCompare(b.Name || ''))
        .map((a) => ({ value: a.Id, label: a.Name || 'Unnamed' })),
    [accounts],
  );

  const formatDisplay = useMemo(() => {
    return (v: string) => {
      const acct = accounts.find((a) => a.Id === v);
      return acct?.Name || 'No Account';
    };
  }, [accounts]);

  return (
    <InlineEditable<string>
      objectType={objectType}
      fieldName={fieldName}
      fieldLabel="Account"
      value={value}
      variant="autocomplete"
      options={options}
      onSave={onSave}
      formatDisplay={formatDisplay}
      placeholder="No Account"
      recordLock={recordLock}
      recordLockedByName={recordLockedByName}
      readOnly={readOnly}
    />
  );
};

export default AccountCell;
