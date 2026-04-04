/**
 * Webhooks Routes
 *
 * Handles:
 * - POST /webhooks/neynar - Handle Neynar miniapp webhook events
 */

type Env = any;

/**
 * Handle webhook routes
 */
export async function handleWebhookRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // POST /webhooks/neynar - Handle Neynar miniapp webhook events
  if (pathname === "/webhooks/neynar" && request.method === "POST") {
    try {
      const event = await request.json() as {
        type: 'miniapp.add' | 'miniapp.remove' | 'notifications.enabled' | 'notifications.disabled';
        fid: number;
        timestamp: string;
        notification_details?: {
          url: string;
          token: string;
        };
      };

      console.log(`[Webhook] Received ${event.type} event for FID ${event.fid}`);

      // Update miniapp status in KV based on event type
      const key = `miniapp_added:${event.fid}`;

      switch (event.type) {
        case 'miniapp.add':
          await env.KV_USER_PROFILES.put(key, 'true');
          console.log(`[Webhook] Miniapp added by FID ${event.fid}`);
          break;

        case 'miniapp.remove':
          await env.KV_USER_PROFILES.put(key, 'false');
          console.log(`[Webhook] Miniapp removed by FID ${event.fid}`);
          break;

        case 'notifications.enabled':
          // Store notification enabled status
          const notifKey = `notifications_enabled:${event.fid}`;
          await env.KV_USER_PROFILES.put(notifKey, 'true');
          console.log(`[Webhook] Notifications enabled by FID ${event.fid}`);
          break;

        case 'notifications.disabled':
          // Store notification disabled status
          const notifDisabledKey = `notifications_enabled:${event.fid}`;
          await env.KV_USER_PROFILES.put(notifDisabledKey, 'false');
          console.log(`[Webhook] Notifications disabled by FID ${event.fid}`);
          break;
      }

      return Response.json({ success: true });
    } catch (error) {
      console.error('[Webhook] Error processing Neynar webhook:', error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return null;
}
