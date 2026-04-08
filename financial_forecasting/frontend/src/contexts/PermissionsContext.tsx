import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiService } from '../services/api';
import { setPebbleUserEmail } from '../services/pebbleApi';
import { useAuth } from './AuthContext';

interface PermissionsData {
  user_id: string;
  email: string;
  name: string;
  sf_user_id: string | null;
  profile_name: string | null;
  is_active: boolean;
  /** Phase B-2: link to public.org_users (platform staff identity).
   *  null means the user exists in Bedrock but not yet in public.org_users —
   *  Phase B-5 surfaces a soft-block banner so they know to contact platform admin. */
  org_user_id: string | null;
  permissions: Record<string, boolean>;
}

interface PermissionsContextValue {
  /** Check if the current user has a specific permission */
  can: (key: string) => boolean;
  /** Whether the user has manage_users_roles (admin) */
  isAdmin: boolean;
  /** The user's Salesforce user ID (for ownership checks) */
  sfUserId: string | null;
  /** The user's platform org_users.id, or null if not yet linked. */
  orgUserId: string | null;
  /** True when the user exists in Bedrock but not yet in public.org_users. */
  isPlatformUnlinked: boolean;
  /** The user's profile name */
  profileName: string | null;
  /** Raw permissions map */
  permissions: Record<string, boolean>;
  /** Whether permissions are still loading */
  loading: boolean;
  /** Refetch permissions (e.g., after profile change) */
  refetch: () => void;
}

const PermissionsContext = createContext<PermissionsContextValue>({
  can: () => false,  // Deny by default until permissions load
  isAdmin: false,
  sfUserId: null,
  orgUserId: null,
  isPlatformUnlinked: false,
  profileName: null,
  permissions: {},
  loading: true,
  refetch: () => {},
});

export const usePermissions = () => useContext(PermissionsContext);

export const PermissionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [data, setData] = useState<PermissionsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPermissions = useCallback(async () => {
    if (!user) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const response = await apiService.getMyPermissions();
      setData(response.data?.data || null);
    } catch (err) {
      console.error('Failed to load permissions:', err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  // Set X-User-Email header on Pebble API when user email is resolved
  useEffect(() => {
    if (data?.email) {
      setPebbleUserEmail(data.email);
    }
  }, [data?.email]);

  const can = useCallback(
    (key: string) => {
      if (!data) return false;
      return data.permissions[key] === true;
    },
    [data]
  );

  const value: PermissionsContextValue = {
    can,
    isAdmin: data?.permissions?.manage_users_roles === true,
    sfUserId: data?.sf_user_id || null,
    orgUserId: data?.org_user_id || null,
    // Only flag as unlinked once data has loaded — don't false-positive during initial fetch
    isPlatformUnlinked: !loading && data !== null && data.org_user_id === null,
    profileName: data?.profile_name || null,
    permissions: data?.permissions || {},
    loading,
    refetch: fetchPermissions,
  };

  return (
    <PermissionsContext.Provider value={value}>
      {children}
    </PermissionsContext.Provider>
  );
};
