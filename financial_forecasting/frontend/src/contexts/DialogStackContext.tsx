/**
 * Stackable edit-dialog manager for the Pipeline page.
 *
 * Allows users to open a related entity's edit dialog from inside another
 * dialog (e.g., Opportunity → Account → Contact). Max depth capped at 3
 * to prevent runaway stacking.
 *
 * Usage:
 *   <DialogStackProvider>
 *     <YourPage />
 *     <DialogStackRenderer />
 *   </DialogStackProvider>
 *
 *   // Inside any child component:
 *   const { pushDialog } = useDialogStack();
 *   pushDialog({ type: 'account', id: '001...' });
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';

import OpportunityEditDialog from '../components/OpportunityEditDialog';
import AccountEditDialog from '../components/AccountEditDialog';
import ContactEditDialog from '../components/ContactEditDialog';

// ── Types ───────────────────────────────────────────────────────────────────

export type DialogEntityType = 'opportunity' | 'account' | 'contact';

/** Self-description a dialog passes as the 4th arg of `onOpenRelated` so the
 *  pushed entry can remember the dialog it was launched from — needed because
 *  the top-level dialog on each page (Opportunities/Contacts) is opened via
 *  local state, not pushDialog, so it never enters the stack itself. Carrying
 *  its identity on the first stack entry lets the breadcrumb name it. */
export interface DialogOrigin {
  type: DialogEntityType;
  id?: string;
  label: string;
}

export interface DialogStackEntry {
  type: DialogEntityType;
  id: string;
  /** Human-readable record name for the breadcrumb. Required so every call
   *  site surfaces at compile time if a label is missing. */
  label: string;
  /** Origin (non-stack) dialog this entry was launched from. Only set on the
   *  first stack push for a given drill; cascading in-stack pushes leave this
   *  undefined because the stack itself provides their lineage. */
  parent?: DialogOrigin;
  initialData?: Record<string, any>;
}

interface DialogStackContextValue {
  stack: DialogStackEntry[];
  pushDialog: (entry: DialogStackEntry) => void;
  popDialog: () => void;
  /** Trim the stack to `targetDepth` entries (e.g., clicking a parent crumb
   *  at stack index 1 → popToDepth(2) leaves [0, 1] mounted). */
  popToDepth: (targetDepth: number) => void;
  closeAll: () => void;
  depth: number;
  canPush: boolean;
}

const MAX_DEPTH = 3;

const DialogStackContext = createContext<DialogStackContextValue>({
  stack: [],
  pushDialog: () => {},
  popDialog: () => {},
  popToDepth: () => {},
  closeAll: () => {},
  depth: 0,
  canPush: true,
});

// ── Provider ────────────────────────────────────────────────────────────────

export const DialogStackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stack, setStack] = useState<DialogStackEntry[]>([]);

  const pushDialog = useCallback((entry: DialogStackEntry) => {
    setStack((prev) => {
      if (prev.length >= MAX_DEPTH) {
        toast.error('Maximum dialog depth reached');
        return prev;
      }
      return [...prev, entry];
    });
  }, []);

  const popDialog = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
  }, []);

  const popToDepth = useCallback((targetDepth: number) => {
    setStack((prev) => prev.slice(0, Math.max(0, targetDepth)));
  }, []);

  const closeAll = useCallback(() => {
    setStack([]);
  }, []);

  const value = useMemo<DialogStackContextValue>(
    () => ({
      stack,
      pushDialog,
      popDialog,
      popToDepth,
      closeAll,
      depth: stack.length,
      canPush: stack.length < MAX_DEPTH,
    }),
    [stack, pushDialog, popDialog, popToDepth, closeAll],
  );

  return (
    <DialogStackContext.Provider value={value}>
      {children}
    </DialogStackContext.Provider>
  );
};

// ── Hook ────────────────────────────────────────────────────────────────────

export function useDialogStack() {
  return useContext(DialogStackContext);
}

// ── Renderer ────────────────────────────────────────────────────────────────

export const DialogStackRenderer: React.FC = () => {
  const { stack, popDialog, pushDialog } = useContext(DialogStackContext);
  const queryClient = useQueryClient();

  if (stack.length === 0) return null;

  // Cascading in-stack drill: the parent arg is ignored because the stack
  // itself provides lineage for entries beyond index 0 (the breadcrumb reads
  // stack[0].parent plus the stack chain).
  const handleOpenRelated = (
    type: DialogEntityType,
    id: string,
    label: string,
    _parentInfo?: DialogOrigin,
  ) => {
    pushDialog({ type, id, label });
  };

  return (
    <>
      {stack.map((entry, index) => {
        const handleClose = () => popDialog();

        switch (entry.type) {
          case 'opportunity':
            return (
              <OpportunityEditDialog
                key={`opp-${entry.id}-${index}`}
                open
                onClose={handleClose}
                opportunityId={entry.id}
                initialData={entry.initialData}
                onSaved={() => {
                  queryClient.invalidateQueries('opportunities');
                  popDialog();
                }}
                onOpenRelated={handleOpenRelated}
              />
            );

          case 'account':
            return (
              <AccountEditDialog
                key={`acct-${entry.id}-${index}`}
                open
                onClose={handleClose}
                accountId={entry.id}
                initialData={entry.initialData}
                onSaved={() => {
                  queryClient.invalidateQueries('accounts');
                  queryClient.invalidateQueries('opportunities-for-accounts');
                  popDialog();
                }}
              />
            );

          case 'contact':
            return (
              <ContactEditDialog
                key={`ctct-${entry.id}-${index}`}
                open
                onClose={handleClose}
                contactId={entry.id}
                initialData={entry.initialData}
                onSaved={() => {
                  queryClient.invalidateQueries('all-contacts');
                  popDialog();
                }}
                onOpenRelated={handleOpenRelated}
              />
            );

          default:
            return null;
        }
      })}
    </>
  );
};
