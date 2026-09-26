import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from '../lib/queryClient';

interface Points {
  allowance: number;
  earned: number;
  balance: number;
}

/**
 * Hook for fetching user points with React Query caching.
 * Prevents duplicate API calls across components that need points data.
 */
export function usePoints() {
  const { user, accountId, isAuthenticated } = useAuth();
  
  // Only fetch if we have a valid auth token
  const hasAuthToken = !!(user?.sessionToken || user?.quickAuthToken);
  
  const query = useQuery({
    queryKey: queryKeys.points(accountId ?? undefined),
    queryFn: async (): Promise<Points> => {
      const response = await apiClient.get('/api/points');
      if (!response.ok) {
        throw new Error(`Failed to fetch points: ${response.statusText}`);
      }
      return response.json();
    },
    enabled: isAuthenticated && hasAuthToken && !!accountId,
    staleTime: 60 * 1000, // Points are stable - 1 minute stale time
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    // Disable refetching on mount since we want to use cached data
    refetchOnMount: false,
    refetchOnWindowFocus: false, // Points don't change frequently
  });

  return {
    points: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

