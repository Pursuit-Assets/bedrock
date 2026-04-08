/**
 * PlatformIdentityBanner — Phase B-5 of Claim 3 (staff identity unification).
 *
 * Surfaces a soft warning banner when the current Bedrock user is NOT yet
 * linked to a public.org_users row on the platform. The user can still use
 * Bedrock — this is a soft block — but the banner tells them they need to
 * be added to the platform's staff directory by an admin.
 *
 * Hidden once the user is linked. No-op while permissions are still loading
 * (avoids a flash on initial page load).
 */
import React, { useState } from 'react';
import { Alert, AlertTitle, IconButton, Collapse, Box } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { usePermissions } from '../contexts/PermissionsContext';

export const PlatformIdentityBanner: React.FC = () => {
  const { isPlatformUnlinked, loading } = usePermissions();
  const [dismissed, setDismissed] = useState(false);

  // Don't render anything until permissions have loaded — avoids flash
  if (loading) return null;
  if (!isPlatformUnlinked) return null;
  if (dismissed) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <Collapse in={!dismissed}>
        <Alert
          severity="warning"
          variant="outlined"
          action={
            <IconButton
              aria-label="dismiss"
              color="inherit"
              size="small"
              onClick={() => setDismissed(true)}
            >
              <CloseIcon fontSize="inherit" />
            </IconButton>
          }
        >
          <AlertTitle>Pending platform onboarding</AlertTitle>
          You're using Bedrock, but you don't appear in the platform's staff
          directory yet (<code>public.org_users</code>). You can keep working —
          this won't block anything in Bedrock — but features that join across
          tools (Product Discovery, cross-tool activity feeds) won't see you
          until an admin adds your email to <code>public.org_users</code>. Ask
          a Bedrock admin to coordinate with the platform team if this seems
          wrong.
        </Alert>
      </Collapse>
    </Box>
  );
};

export default PlatformIdentityBanner;
