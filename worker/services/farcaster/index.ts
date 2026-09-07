/**
 * farcaster/ — pluggable Farcaster *read* providers (casting lives in casting/).
 *
 * Usage:
 *   import { initFarcasterData } from '../services/farcaster';
 *   const user = await initFarcasterData(env).getUser(fid);      // profile
 *   const fids = await initFarcasterData(env).getFidsByAddresses(addrs);
 *
 * Provider order is `FC_DATA_PROVIDER_ORDER` (default `neynar,hub`).
 * Adding a provider: implement FarcasterDataProvider, register it in
 * initFarcasterData(). No route handler changes.
 */

export type {
  FarcasterUser,
  FarcasterChannel,
  FarcasterDataProvider,
  GetUsersOptions,
} from './FarcasterDataProvider';
export { NoProviderError } from './FarcasterDataProvider';
export { NeynarDataProvider, NeynarError } from './NeynarDataProvider';
export { HubDataProvider } from './HubDataProvider';
export { FarcasterDataRouter, initFarcasterData } from './FarcasterDataRouter';

export type { LoginProvider } from './LoginProvider';
export { NeynarLoginProvider, initLoginProvider } from './LoginProvider';

export type {
  NotificationProvider,
  NotificationPayload,
  NotificationFilters,
  NotificationDelivery,
  NotificationResponse,
  NotificationToken,
  NotificationTokensResponse,
  UserNotificationState,
} from './NotificationProvider';
export { NeynarNotificationProvider, initNotificationProvider } from './NeynarNotificationProvider';
