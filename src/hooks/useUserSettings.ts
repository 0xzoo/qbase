import { useState, useEffect, useCallback } from 'react';
import type { Audiences, UserSettings } from '../lib/types';
import { sdk } from '@farcaster/miniapp-sdk';

/**
 * Hook for managing user settings
 * Fetches settings from KV and provides update functions
 */
export function useUserSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch settings from API
  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Get auth token for API request
      const { token } = await sdk.quickAuth.getToken();
      
      const response = await fetch('/api/settings', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch settings: ${response.statusText}`);
      }

      const data = await response.json() as UserSettings;
      setSettings(data);
    } catch (err) {
      console.error('Error fetching settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch settings');
      // Set default settings on error
      setSettings({
        defaultAudience: 'Private',
        defaultQuestionAudience: 'Public',
        theme: 'auto',
        notifications: {
          directQuestions: true,
          answers: true,
          reactions: true,
        },
        updatedAt: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Update settings (partial update)
  const updateSettings = useCallback(async (updates: Partial<Omit<UserSettings, 'updatedAt'>>) => {
    setError(null);
    
    try {
      const { token } = await sdk.quickAuth.getToken();
      
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

      const data = await response.json() as UserSettings;
      setSettings(data);
      return data;
    } catch (err) {
      console.error('Error updating settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to update settings');
      throw err;
    }
  }, []);

  // Reset settings to defaults
  const resetSettings = useCallback(async () => {
    setError(null);
    
    try {
      const { token } = await sdk.quickAuth.getToken();
      
      const response = await fetch('/api/settings', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to reset settings: ${response.statusText}`);
      }

      const data = await response.json() as UserSettings;
      setSettings(data);
      return data;
    } catch (err) {
      console.error('Error resetting settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to reset settings');
      throw err;
    }
  }, []);

  // Update a single setting
  const updateDefaultAudience = useCallback(async (audience: Audiences) => {
    return updateSettings({ defaultAudience: audience });
  }, [updateSettings]);

  const updateDefaultQuestionAudience = useCallback(async (audience: Audiences) => {
    return updateSettings({ defaultQuestionAudience: audience });
  }, [updateSettings]);

  const updateTheme = useCallback(async (theme: 'light' | 'dark' | 'auto') => {
    return updateSettings({ theme });
  }, [updateSettings]);

  const updateNotifications = useCallback(async (notifications: Partial<NonNullable<UserSettings['notifications']>>) => {
    if (!settings?.notifications) return;
    
    return updateSettings({
      notifications: {
        ...settings.notifications,
        ...notifications,
      },
    });
  }, [settings, updateSettings]);

  // Load settings on mount
  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return {
    settings,
    loading,
    error,
    updateSettings,
    resetSettings,
    updateDefaultAudience,
    updateDefaultQuestionAudience,
    updateTheme,
    updateNotifications,
    refetch: fetchSettings,
  };
}

