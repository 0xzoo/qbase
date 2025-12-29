export interface NotificationPayload {
  title: string;
  body: string;
  target_url: string;
  uuid?: string;
}

export interface NotificationFilters {
  exclude_fids?: number[];
  following_fid?: number;
  minimum_user_score?: number;
  near_location?: {
    latitude: number;
    longitude: number;
    address?: {
      city?: string;
      state?: string;
      state_code?: string;
      country?: string;
      country_code?: string;
    };
    radius?: number;
  };
}

export interface NotificationDelivery {
  object: string;
  fid: number;
  status: 'success' | 'failed';
  app_fid: number;
}

export interface NotificationResponse {
  notification_deliveries: NotificationDelivery[];
}

export interface NotificationToken {
  object: string;
  url: string;
  token: string;
  status: 'enabled' | 'disabled';
  fid: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationTokensResponse {
  notification_tokens: NotificationToken[];
  next?: {
    cursor: string;
  };
}

export interface UserNotificationState {
  notifications_enabled: Array<{
    domain: string;
    status: string;
    updated_at: string;
  }>;
}

/**
 * Service for managing Farcaster miniapp notifications via Neynar
 * 
 * Features:
 * - Send notifications to specific users
 * - Fetch notification tokens
 * - Check user notification state
 * - Automatic token management via Neynar
 * 
 * @see https://docs.neynar.com/docs/send-notifications-to-mini-app-users
 */
export class NotificationService {
  private neynarApiKey: string;

  constructor(neynarApiKey: string) {
    this.neynarApiKey = neynarApiKey;
  }

  /**
   * Create NotificationService from environment
   */
  static fromEnv(env: any): NotificationService {
    return new NotificationService(env.NEYNAR_API_KEY);
  }

  /**
   * Send notification to specific users
   * 
   * @param fids - Array of FIDs to send notification to
   * @param notification - Notification payload with title, body, and target URL
   * @param filters - Optional filters to narrow down recipients
   * @returns Notification delivery results
   * 
   * @example
   * ```typescript
   * const service = NotificationService.fromEnv(env);
   * await service.sendToUsers(
   *   [123, 456],
   *   {
   *     title: 'New Question',
   *     body: 'Someone asked about AI ethics',
   *     target_url: 'https://qbase.tech/question/abc123'
   *   },
   *   {
   *     minimum_user_score: 0.5
   *   }
   * );
   * ```
   */
  async sendToUsers(
    fids: number[],
    notification: NotificationPayload,
    filters?: NotificationFilters
  ): Promise<NotificationResponse> {
    if (fids.length === 0) {
      throw new Error('At least one FID is required');
    }

    const response = await fetch(
      'https://api.neynar.com/v2/farcaster/frame/notifications',
      {
        method: 'POST',
        headers: {
          'x-api-key': this.neynarApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target_fids: fids,
          filters,
          notification: {
            ...notification,
            uuid: notification.uuid || crypto.randomUUID(),
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send notification: ${response.status} ${errorText}`);
    }

    return await response.json() as NotificationResponse;
  }

  /**
   * Get notification tokens for users
   * 
   * @param fids - Optional array of FIDs to filter by (max 100)
   * @param limit - Number of results to fetch (default 100)
   * @param cursor - Pagination cursor
   * @returns Notification tokens and pagination cursor
   * 
   * @example
   * ```typescript
   * const service = NotificationService.fromEnv(env);
   * const { notification_tokens, next } = await service.getNotificationTokens([123, 456]);
   * console.log(`Found ${notification_tokens.length} tokens`);
   * ```
   */
  async getNotificationTokens(
    fids?: number[],
    limit: number = 100,
    cursor?: string
  ): Promise<NotificationTokensResponse> {
    const params = new URLSearchParams();
    
    if (fids && fids.length > 0) {
      if (fids.length > 100) {
        throw new Error('Maximum 100 FIDs allowed per request');
      }
      params.append('fids', fids.join(','));
    }
    
    params.append('limit', limit.toString());
    
    if (cursor) {
      params.append('cursor', cursor);
    }

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/frame/notification_tokens?${params}`,
      {
        headers: {
          'x-api-key': this.neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch tokens: ${response.status} ${errorText}`);
    }

    return await response.json() as NotificationTokensResponse;
  }

  /**
   * Get notification state for a user across all miniapp domains
   * 
   * @param fid - User's FID
   * @returns User notification state showing enabled domains
   * 
   * @example
   * ```typescript
   * const service = NotificationService.fromEnv(env);
   * const state = await service.getUserNotificationState(123);
   * const enabled = state.notifications_enabled.some(n => n.status === 'enabled');
   * ```
   */
  async getUserNotificationState(fid: number): Promise<UserNotificationState> {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/app_host/user/state?fid=${fid}`,
      {
        headers: {
          'x-api-key': this.neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get user state: ${response.status} ${errorText}`);
    }

    return await response.json() as UserNotificationState;
  }

  /**
   * Check if a user has notifications enabled for our miniapp
   * 
   * @param fid - User's FID
   * @returns True if notifications are enabled
   */
  async hasNotificationsEnabled(fid: number): Promise<boolean> {
    try {
      const tokens = await this.getNotificationTokens([fid]);
      return tokens.notification_tokens.some(token => 
        token.fid === fid && token.status === 'enabled'
      );
    } catch (error) {
      console.error(`Error checking notification status for FID ${fid}:`, error);
      return false;
    }
  }

  /**
   * Get all users with notifications enabled
   * 
   * @param limit - Number of results per page
   * @returns Array of FIDs with notifications enabled
   */
  async getAllEnabledUsers(limit: number = 100): Promise<number[]> {
    const enabledFids: number[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.getNotificationTokens(undefined, limit, cursor);
      
      const enabled = response.notification_tokens
        .filter(token => token.status === 'enabled')
        .map(token => token.fid);
      
      enabledFids.push(...enabled);
      
      cursor = response.next?.cursor;
    } while (cursor);

    return enabledFids;
  }

  /**
   * Send notification with error handling and logging
   * 
   * @param fids - Array of FIDs to send notification to
   * @param notification - Notification payload
   * @param filters - Optional filters
   * @returns Success status and delivery results
   */
  async sendWithErrorHandling(
    fids: number[],
    notification: NotificationPayload,
    filters?: NotificationFilters
  ): Promise<{ success: boolean; deliveries?: NotificationDelivery[]; error?: string }> {
    try {
      const response = await this.sendToUsers(fids, notification, filters);
      
      const successCount = response.notification_deliveries.filter(
        d => d.status === 'success'
      ).length;
      
      console.log(
        `Sent notification to ${successCount}/${fids.length} users: "${notification.title}"`
      );
      
      return {
        success: true,
        deliveries: response.notification_deliveries,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to send notification:', errorMessage);
      
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

