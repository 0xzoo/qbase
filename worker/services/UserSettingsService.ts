import type { Audiences, UserSettings } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Default settings for new users
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultAudience: 'Private',
  defaultQuestionAudience: 'Public',
  theme: 'auto',
  notifications: {
    directQuestions: true,
    answers: true,
    reactions: true,
  },
  updatedAt: Date.now(),
};

/**
 * Service for managing user settings in KV storage
 * Uses KV_USER_PROFILES namespace with key pattern: settings:{fid}
 */
export class UserSettingsService {
  private kv: any;

  constructor(kv: any) {
    this.kv = kv;
  }

  /**
   * Create instance from environment bindings
   */
  static fromEnv(env: Env): UserSettingsService {
    return new UserSettingsService(env.KV_USER_PROFILES);
  }

  /**
   * Generate KV key for user settings
   */
  private getKey(fid: number): string {
    return `settings:${fid}`;
  }

  /**
   * Get user settings from KV
   * Returns default settings if none exist
   */
  async getSettings(fid: number): Promise<UserSettings> {
    const key = this.getKey(fid);
    const data = await this.kv.get(key);

    if (!data) {
      // Return default settings for new users
      return { ...DEFAULT_USER_SETTINGS };
    }

    try {
      const settings = JSON.parse(data) as UserSettings;
      // Merge with defaults to ensure all fields exist (for forward compatibility)
      return {
        ...DEFAULT_USER_SETTINGS,
        ...settings,
        notifications: {
          ...DEFAULT_USER_SETTINGS.notifications,
          ...settings.notifications,
        },
      };
    } catch (error) {
      console.error(`Failed to parse settings for FID ${fid}:`, error);
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  /**
   * Update user settings in KV
   * Performs a partial update - only provided fields are updated
   */
  async updateSettings(
    fid: number,
    updates: Partial<Omit<UserSettings, 'updatedAt'>>
  ): Promise<UserSettings> {
    const currentSettings = await this.getSettings(fid);

    const updatedSettings: UserSettings = {
      ...currentSettings,
      ...updates,
      // Deep merge notifications
      notifications: {
        ...currentSettings.notifications,
        ...updates.notifications,
      },
      updatedAt: Date.now(),
    };

    const key = this.getKey(fid);
    await this.kv.put(key, JSON.stringify(updatedSettings));

    return updatedSettings;
  }

  /**
   * Reset user settings to defaults
   */
  async resetSettings(fid: number): Promise<UserSettings> {
    const defaultSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      updatedAt: Date.now(),
    };

    const key = this.getKey(fid);
    await this.kv.put(key, JSON.stringify(defaultSettings));

    return defaultSettings;
  }

  /**
   * Delete user settings from KV
   */
  async deleteSettings(fid: number): Promise<void> {
    const key = this.getKey(fid);
    await this.kv.delete(key);
  }

  /**
   * Check if user has customized settings
   */
  async hasCustomSettings(fid: number): Promise<boolean> {
    const key = this.getKey(fid);
    const data = await this.kv.get(key);
    return data !== null;
  }
}

