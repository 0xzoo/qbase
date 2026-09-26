import React, { createContext, useContext, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UserSettings, Audiences } from '../lib/types';
import { queryKeys } from '../lib/queryClient';
import { useAuth } from './AuthContext';

// Default settings
const DEFAULT_SETTINGS: UserSettings = {
  defaultAudience: 'Private',
  theme: 'auto',
  notifications: {
    directQuestions: true,
    answers: true,
    reactions: true,
  },
  updatedAt: Date.now(),
};

interface SettingsContextType {
  settings: UserSettings;
  isLoading: boolean;
  error: Error | null;
  updateSettings: (updates: Partial<Omit<UserSettings, 'updatedAt'>>) => Promise<UserSettings | undefined>;
  updateDefaultAudience: (audience: Audiences) => Promise<UserSettings | undefined>;
  refetch: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// API functions
async function fetchSettings(token: string | null): Promise<UserSettings> {
  if (!token) {
    return DEFAULT_SETTINGS;
  }
  
  const response = await fetch('/api/settings', {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      return DEFAULT_SETTINGS;
    }
    throw new Error(`Failed to fetch settings: ${response.statusText}`);
  }

  return response.json();
}

async function patchSettings(
  token: string,
  updates: Partial<Omit<UserSettings, 'updatedAt'>>
): Promise<UserSettings> {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error(`Failed to update settings: ${response.statusText}`);
  }

  return response.json();
}

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { accountId, getAuthToken } = useAuth();
  const queryClient = useQueryClient();
  const token = getAuthToken();
  // Settings belong to the person (account), not the Farcaster fid.
  const fid = accountId ?? undefined;

  // Query for fetching settings
  const {
    data: settings = DEFAULT_SETTINGS,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.settings(fid),
    queryFn: () => fetchSettings(token),
    enabled: !!fid && !!token,
    staleTime: 60 * 1000, // Settings are stable - 1 minute stale time
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnMount: false, // Use cached data, don't refetch on every mount
    refetchOnWindowFocus: false, // Settings don't change externally
  });

  // Mutation for updating settings with optimistic updates
  const updateSettingsMutation = useMutation({
    mutationFn: (updates: Partial<Omit<UserSettings, 'updatedAt'>>) => {
      if (!token) throw new Error('Not authenticated');
      return patchSettings(token, updates);
    },
    // Optimistic update
    onMutate: async (updates) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.settings(fid) });

      // Snapshot the previous value
      const previousSettings = queryClient.getQueryData<UserSettings>(queryKeys.settings(fid));

      // Optimistically update to the new value
      if (previousSettings) {
        queryClient.setQueryData<UserSettings>(queryKeys.settings(fid), {
          ...previousSettings,
          ...updates,
          updatedAt: Date.now(),
        });
      }

      // Return a context object with the snapshotted value
      return { previousSettings };
    },
    // If the mutation fails, use the context returned from onMutate to roll back
    onError: (_err, _updates, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.settings(fid), context.previousSettings);
      }
    },
    // Always refetch after error or success
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings(fid) });
    },
  });

  const updateSettings = useCallback(async (updates: Partial<Omit<UserSettings, 'updatedAt'>>) => {
    return updateSettingsMutation.mutateAsync(updates);
  }, [updateSettingsMutation]);

  const updateDefaultAudience = useCallback(async (audience: Audiences) => {
    return updateSettings({ defaultAudience: audience });
  }, [updateSettings]);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        isLoading,
        error: error as Error | null,
        updateSettings,
        updateDefaultAudience,
        refetch: () => refetch(),
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

