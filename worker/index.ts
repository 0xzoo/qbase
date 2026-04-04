// @ts-nocheck
export { QAgent } from './agents/QAgent';
import { handleFollowRoutes } from './routes/follows';
import { handleAuthRoutes } from './routes/auth';
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const r1 = await handleFollowRoutes(request, env);
    const r2 = await handleAuthRoutes(request, env);
    return new Response('ok');
  }
} as any;
