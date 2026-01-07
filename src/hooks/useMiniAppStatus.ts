import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { queryKeys } from '../lib/queryClient';

interface MiniAppStatus {
  miniAppAdded: boolean;
  notificationsEnabled: boolean;
}

/**
 * Hook for fetching miniapp status (added + notifications) in a single API call.
 * Prevents duplicate fetches for status and notifications separately.
 */
export function useMiniAppStatus() {
  const { user, isMiniApp } = useAuth();
  const token = user?.quickAuthToken;
  const queryClient = useQueryClient();
  
  const query = useQuery({
    queryKey: queryKeys.miniAppStatus(user?.fid),
    queryFn: async (): Promise<MiniAppStatus> => {
      // Fetch both status endpoints in parallel
      const [statusRes, notifRes] = await Promise.all([
        fetch('/api/miniapp/status', {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch('/api/miniapp/notifications', {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      const statusData = statusRes.ok 
        ? await statusRes.json() as { miniAppAdded: boolean }
        : { miniAppAdded: false };
      
      const notifData = notifRes.ok 
        ? await notifRes.json() as { notificationsEnabled: boolean }
        : { notificationsEnabled: false };

      return {
        miniAppAdded: statusData.miniAppAdded,
        notificationsEnabled: notifData.notificationsEnabled,
      };
    },
    enabled: isMiniApp && !!token && !!user?.fid,
    staleTime: 60 * 1000, // Status is stable - 1 minute stale time
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnMount: false, // Use cached data
    refetchOnWindowFocus: false, // Status doesn't change frequently
  });

  // Functions to update cache when SDK events fire
  const setMiniAppAdded = (added: boolean) => {
    queryClient.setQueryData<MiniAppStatus>(queryKeys.miniAppStatus(user?.fid), (old) => ({
      miniAppAdded: added,
      notificationsEnabled: old?.notificationsEnabled ?? false,
    }));
  };

  const setNotificationsEnabled = (enabled: boolean) => {
    queryClient.setQueryData<MiniAppStatus>(queryKeys.miniAppStatus(user?.fid), (old) => ({
      miniAppAdded: old?.miniAppAdded ?? false,
      notificationsEnabled: enabled,
    }));
  };

  return {
    miniAppAdded: query.data?.miniAppAdded ?? false,
    notificationsEnabled: query.data?.notificationsEnabled ?? false,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    setMiniAppAdded,
    setNotificationsEnabled,
  };
}

