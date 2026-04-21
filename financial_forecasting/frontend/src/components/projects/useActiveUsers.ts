import { useQuery } from 'react-query';
import { apiService } from '../../services/api';
import type { ActiveUser } from './types';

const QUERY_KEY = ['active-users'];

/** Active Pursuit staff eligible to be picked as Project owners.
 *  Backed by GET /api/users/active, which excludes Systems Admin service
 *  accounts. Cached for 60s — rarely changes and many components read it. */
export function useActiveUsers() {
  const { data, isLoading, error } = useQuery(
    QUERY_KEY,
    async () => {
      const res = await apiService.getActiveUsers();
      return (res.data?.data || res.data || []) as ActiveUser[];
    },
    { staleTime: 60_000 }
  );

  return {
    activeUsers: data || [],
    isLoading,
    error,
  };
}
