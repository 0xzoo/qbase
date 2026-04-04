/**
 * Q Agent Routes
 *
 * Handles:
 * - /api/q/* - Forward all requests to QAgent Durable Object
 */

type Env = any;

/**
 * Handle QAgent routes - proxy to Durable Object
 */
export async function handleQAgentRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // =========================================================================
  // Q Agent Routes - /api/q/*
  // Routes forwarded to the QAgent Durable Object
  // =========================================================================
  if (pathname.startsWith("/api/q/")) {
    try {
      // Get the singleton Q instance
      const qId = env.QGENT.idFromName("Q");
      const qStub = env.QGENT.get(qId);

      // Strip the /api/q prefix and forward to the DO
      const doPath = pathname.replace("/api/q", "");
      const doUrl = new URL(doPath || "/", url.origin);
      doUrl.search = url.search;

      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      return qStub.fetch(doRequest);
    } catch (error) {
      console.error("[Q] Error forwarding to QAgent:", error);
      return Response.json({ error: "Q unavailable" }, { status: 500 });
    }
  }

  return null;
}
