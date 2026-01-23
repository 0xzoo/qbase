import { useCallback } from 'react';
import { useSettings } from '../context/SettingsContext';
import type { UserSettings } from '../lib/types';

/**
 * Hook for managing user settings
 * 
 * Uses React Query under the hood via SettingsContext for:
 * - Automatic caching and background refetching
 * - Optimistic updates for instant UI feedback
 * - Stale-while-revalidate pattern for improved UX
 */
export function useUserSettings() {
  const {
    settings,
    isLoading: loading,
    error,
    updateSettings,
    updateDefaultAudience,
    refetch,
  } = useSettings();

  // These are thin wrappers for API compatibility with existing code
  const updateTheme = useCallback(async (theme: 'light' | 'dark' | 'auto') => {
    return updateSettings({ theme });
  }, [updateSettings]);

  const updateNotifications = useCallback(async (
    notifications: Partial<NonNullable<UserSettings['notifications']>>
  ) => {
    if (!settings?.notifications) return;
    
    return updateSettings({
      notifications: {
        ...settings.notifications,
        ...notifications,
      },
    });
  }, [settings, updateSettings]);

  const resetSettings = useCallback(async () => {
    // Reset is just setting to defaults - the API handles this
    return updateSettings({
      defaultAudience: 'Private',
      theme: 'auto',
      notifications: {
        directQuestions: true,
        answers: true,
        reactions: true,
      },
      includeEmbedInAnswerCasts: false,
      includeEmbedInQuestionCasts: true,
    });
  }, [updateSettings]);

  return {
    settings,
    loading,
    error,
    updateSettings,
    resetSettings,
    updateDefaultAudience,
    updateTheme,
    updateNotifications,
    refetch,
  };
}
