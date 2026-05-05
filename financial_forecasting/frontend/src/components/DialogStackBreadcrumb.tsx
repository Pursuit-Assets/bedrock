import React from 'react';
import { Box, Breadcrumbs, Link, Typography } from '@mui/material';
import { useDialogStack, DialogEntityType } from '../contexts/DialogStackContext';

const TYPE_LABEL: Record<DialogEntityType, string> = {
  opportunity: 'Opportunity',
  account: 'Account',
  contact: 'Contact',
};

/** Breadcrumb that sits atop each stacked edit drawer so users can see the
 *  chain of records they drilled through — and that clicking Cancel (or a
 *  crumb) pops back up it.
 *
 *  Renders when either:
 *    - stack.length > 1 (two or more drill levels on the stack), or
 *    - stack[0].parent exists (first entry was launched from a local-state
 *      "origin" dialog that isn't itself on the stack).
 *
 *  Outside a DialogStackProvider the hook returns an empty stack, so this
 *  component yields null — safe to render in dialogs that are also used on
 *  pages without the stack context (Priorities, Progress, etc.). */
const DialogStackBreadcrumb: React.FC = () => {
  const { stack, popToDepth, closeAll } = useDialogStack();

  const parent = stack[0]?.parent;
  const shouldRender = stack.length > 1 || !!parent;
  if (!shouldRender) return null;

  // chainIndex 0 is the leftmost visible crumb; the last is the current
  // (non-clickable) record. When a parent exists, it occupies chainIndex 0
  // and the stack begins at chainIndex 1.
  type Crumb = {
    label: string;
    type: DialogEntityType;
    isParent: boolean;
    stackIndex: number; // -1 when isParent
  };

  const chain: Crumb[] = [];
  if (parent) {
    chain.push({ label: parent.label, type: parent.type, isParent: true, stackIndex: -1 });
  }
  stack.forEach((entry, i) => {
    chain.push({ label: entry.label, type: entry.type, isParent: false, stackIndex: i });
  });

  const handleClick = (c: Crumb) => {
    if (c.isParent) {
      closeAll();
      return;
    }
    // Pop so the clicked entry becomes the top: depth = stackIndex + 1.
    popToDepth(c.stackIndex + 1);
  };

  return (
    <Box
      sx={{
        px: 2,
        py: 0.75,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'grey.50',
        fontSize: '0.8rem',
      }}
    >
      <Breadcrumbs
        separator="›"
        aria-label="dialog stack breadcrumb"
        sx={{ '& .MuiBreadcrumbs-separator': { mx: 0.75 }, fontSize: '0.8rem' }}
      >
        {chain.map((c, i) => {
          const isLast = i === chain.length - 1;
          const isLeftmost = i === 0;

          if (isLast) {
            return (
              <Typography
                key={`${c.isParent ? 'p' : 's'}-${c.stackIndex}`}
                component="span"
                sx={{ fontSize: '0.8rem', color: 'text.primary', fontWeight: 500 }}
              >
                {c.label}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  ({TYPE_LABEL[c.type]})
                </Typography>
              </Typography>
            );
          }

          return (
            <Link
              key={`${c.isParent ? 'p' : 's'}-${c.stackIndex}`}
              component="button"
              underline="hover"
              onClick={() => handleClick(c)}
              sx={{
                fontSize: '0.8rem',
                color: 'primary.main',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              {isLeftmost ? `← ${c.label}` : c.label}
            </Link>
          );
        })}
      </Breadcrumbs>
    </Box>
  );
};

export default DialogStackBreadcrumb;
