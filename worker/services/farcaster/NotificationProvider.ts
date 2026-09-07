/**
 * NotificationProvider — miniapp push notifications behind one interface.
 *
 * Today Neynar hosts the notification tokens and fans out the sends
 * (`NeynarNotificationProvider`). A self-hosted implementation (tokens from
 * the miniapp webhook into KV_FRAME_NOTIFICATIONS, direct POST to each
 * client's notification URL) is a later card; callers only see this interface.
 */

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


export interface NotificationProvider {
  readonly name: string;
  sendToUsers(fids: number[], notification: NotificationPayload, filters?: NotificationFilters): Promise<NotificationResponse>;
  getNotificationTokens(fids?: number[], limit?: number, cursor?: string): Promise<NotificationTokensResponse>;
  hasNotificationsEnabled(fid: number): Promise<boolean>;
  getAllEnabledUsers(limit?: number): Promise<number[]>;
  sendWithErrorHandling(
    fids: number[],
    notification: NotificationPayload,
    filters?: NotificationFilters,
  ): Promise<{ success: boolean; deliveries?: NotificationDelivery[]; error?: string }>;
}
