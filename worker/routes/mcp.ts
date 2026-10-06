/**
 * /mcp — the personal MCP endpoint (docs/specs/personal-mcp.md §4).
 *
 * Streamable HTTP, stateless: every request is one JSON-RPC message (or a
 * batch) in a POST, answered with application/json. No session id, no SSE
 * stream (GET → 405), which the transport allows. Hand-rolled rather than
 * Cloudflare's `agents` McpAgent: that needs a Durable Object per session,
 * and five read tools with no server-initiated messages don't.
 *
 * Auth: `Authorization: Bearer qb_…`, a key grant (GrantService). The grant
 * decides what the tools may read; every tools/call is logged.
 *
 *   claude mcp add --transport http qbase https://qbase.tech/mcp --header "Authorization: Bearer qb_…"
 */

import { requireAgentKey, toGrant } from '../services/personal/GrantService';
import { TOOLS, ToolError, callTool } from '../services/personal/tools';
import { RateLimitService } from '../services/RateLimitService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'qbase', title: 'qbase: your answers', version: '0.1.0' };
const CALLS_PER_MINUTE = 60;

const INSTRUCTIONS =
  'qbase holds the owner\'s answers to questions, in their own words, dated, with every change of mind kept. ' +
  'When helping the owner decide something, call get_context with the decision first. ' +
  'Treat positions as what the owner said on that date, not as current fact; quiz traits are measured, not stated. ' +
  'When get_context lists gaps that matter, ask the owner directly rather than guessing. ' +
  'You can read but never answer on the owner\'s behalf. Everything you read here is logged where the owner can see it.';

type Id = string | number | null;
interface RpcRequest { jsonrpc?: string; id?: Id; method?: unknown; params?: Record<string, unknown> }

const ok = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function unauthorized(): Response {
  return Response.json(fail(null, -32001, 'A qbase key is required: Authorization: Bearer qb_…'), {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer realm="qbase", error="invalid_token"' },
  });
}

async function handleOne(env: Env, ownerKey: number, grantRow: Parameters<typeof toGrant>[0], msg: RpcRequest): Promise<object | null> {
  const isNotification = msg.id === undefined;
  const id: Id = msg.id ?? null;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : fail(id, -32600, 'Invalid Request');

  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return isNotification ? null : ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool: ${name}`);
      try {
        const data = await callTool(env, ownerKey, toGrant(grantRow), name, args);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
      } catch (e) {
        if (e instanceof ToolError) return ok(id, { content: [{ type: 'text', text: e.message }], isError: true });
        console.error(`[mcp] ${name} failed:`, e);
        return ok(id, { content: [{ type: 'text', text: `${name} failed; try again shortly.` }], isError: true });
      }
    }
    default:
      // Notifications (initialized, cancelled, …) need no reply; unknown requests get -32601.
      return isNotification ? null : fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcpRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp') return null;
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  const grantRow = await requireAgentKey(request, env);
  if (!grantRow) return unauthorized();
  if (!(await RateLimitService.fromEnv(env).checkLimit(`grant:${grantRow.id}`, CALLS_PER_MINUTE, 60, 'mcp'))) {
    return Response.json(fail(null, -32000, 'Rate limit: slow down'), { status: 429, headers: { 'Retry-After': '60' } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(fail(null, -32700, 'Parse error'), { status: 400 });
  }

  const ownerKey = Number(grantRow.owner_key);
  if (Array.isArray(body)) {
    if (body.length === 0) return Response.json(fail(null, -32600, 'Invalid Request'), { status: 400 });
    const out = (await Promise.all(body.map((m) => handleOne(env, ownerKey, grantRow, m as RpcRequest)))).filter((r) => r !== null);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const res = await handleOne(env, ownerKey, grantRow, body as RpcRequest);
  return res ? Response.json(res) : new Response(null, { status: 202 });
}
