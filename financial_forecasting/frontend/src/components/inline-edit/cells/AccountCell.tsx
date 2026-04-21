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
  /**
   * Pre-joined Account.Name from the parent record's SOQL query (e.g.
   * `opp.Account.Name`). Used as the authoritative display-mode label so
   * we don't depend on the bulk `/api/salesforce/accounts` list — which
   * is currently capped at 2000 rows and therefore drops some accounts
   * alphabetically (pending JP's `pr-contacts-accounts-pagination`).
   * Without this fallback, any opp whose Account sorts after the 2000th
   * renders as "No Account" in the grid even though it IS linked in SF.
   */
  displayName?: string | null;
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
  displayName,
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

  // Preference order for display label:
  //   1. `displayName` prop (from opp's Account.Name SOQL join) — always
  //      accurate, never truncated.
  //   2. Lookup in local `accounts` list — accurate only for the first
  //      2000 rows; kept as a fallback so call sites that haven't yet
  //      passed `displayName` still render something reasonable.
  //   3. Literal "No Account" — means the record really has no AccountId.
  const formatDisplay = useMemo(() => {
    return (v: string) => {
      if (!v) return 'No Account';
      if (displayName) return displayName;
      const acct = accounts.find((a) => a.Id === v);
      return acct?.Name || 'No Account';
    };
  }, [accounts, displayName]);

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
