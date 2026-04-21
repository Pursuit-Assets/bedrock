/**
 * Component tests for SaveBlockedDialog.
 *
 * Pins the contract: the dialog shows the missing field names, renders
 * a human-readable title, and invokes onClose when dismissed.
 * Uses `toBeTruthy()` / `toBeNull()` rather than `toBeInTheDocument`
 * since the project doesn't import @testing-library/jest-dom.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SaveBlockedDialog from './SaveBlockedDialog';

describe('SaveBlockedDialog', () => {
  it('renders each missing field name when open', () => {
    render(
      <SaveBlockedDialog
        open
        onClose={() => {}}
        missingFields={['Contract_Start_Date__c', 'Payment_Terms__c']}
        recordLabel="opportunity"
      />,
    );
    expect(screen.getByText(/Save blocked/i)).toBeTruthy();
    expect(screen.getByText('Contract_Start_Date__c')).toBeTruthy();
    expect(screen.getByText('Payment_Terms__c')).toBeTruthy();
  });

  it('pluralizes the field count correctly', () => {
    const { rerender } = render(
      <SaveBlockedDialog
        open
        onClose={() => {}}
        missingFields={['X']}
        recordLabel="contact"
      />,
    );
    expect(screen.getByText(/one field/i)).toBeTruthy();

    rerender(
      <SaveBlockedDialog
        open
        onClose={() => {}}
        missingFields={['X', 'Y', 'Z']}
        recordLabel="contact"
      />,
    );
    expect(screen.getByText(/3 fields/i)).toBeTruthy();
  });

  it('renders the record-label in the body copy', () => {
    render(
      <SaveBlockedDialog
        open
        onClose={() => {}}
        missingFields={['X']}
        recordLabel="payment"
      />,
    );
    expect(screen.getByText(/from this payment/i)).toBeTruthy();
  });

  it('invokes onClose when the Close button is clicked', () => {
    const onClose = jest.fn();
    render(
      <SaveBlockedDialog
        open
        onClose={onClose}
        missingFields={['X']}
        recordLabel="opportunity"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render content when open=false', () => {
    render(
      <SaveBlockedDialog
        open={false}
        onClose={() => {}}
        missingFields={['Contract_Start_Date__c']}
        recordLabel="opportunity"
      />,
    );
    expect(screen.queryByText('Contract_Start_Date__c')).toBeNull();
  });
});
