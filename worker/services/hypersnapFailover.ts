/**
 * Failover across Hypersnap nodes.
 *
 * qbase talks to one node by name (`HYPERSNAP_ENDPOINT` / `HUB_ENDPOINT`, our
 * own hs1) and every caller builds its URLs from that name. This wraps `fetch`
 * so a request to the primary that cannot be served is replayed, same path and
 * body, against `HYPERSNAP_FALLBACK_ENDPOINTS` (comma list; Haatz). Requests to
 * any other host pass straight through.
 *
 * What counts as "cannot be served":
 *   - the fetch throws (DNS, TLS, reset) or exceeds the per-attempt timeout;
 *   - reads (GET/HEAD): 429 or any 5xx;
 *   - writes: only gateway statuses (502/503/504, Cloudflare 52x/530), where
 *     the node itself never answered. A 4xx or 500 from `submitMessage` is the
 *     node's verdict on the message and is returned as is.
 *
 * A write that timed out may still have landed. Hub messages are identified by
 * their hash, so the replay is harmless: the second node either accepts it or
 * answers `bad_request.duplicate`, which HypersnapService treats as success.
 *
 * A node that failed is skipped for COOLDOWN_MS in this isolate, so an outage
 * costs one timeout per isolate per cooldown rather than one per request. If
 * every node is cooling down they are all tried anyway, primary first.
 */

const COOLDOWN_MS = 30_000;
const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 15_000;

/** origin → epoch ms until which it is skipped. Per isolate; best effort by design. */
const coolingDown = new Map<string, number>();

/** Test hook: forget which nodes failed. */
export function resetHypersnapFailover(): void {
  coolingDown.clear();
}

type EndpointEnv = {
  HYPERSNAP_ENDPOINT?: string;
  HUB_ENDPOINT?: string;
  HYPERSNAP_FALLBACK_ENDPOINTS?: string;
};

const trim = (s: string) => s.trim().replace(/\/+$/, '');

/** The nodes named as primary in env, without trailing slashes, de-duplicated. */
export function hypersnapPrimaries(env: EndpointEnv): string[] {
  return Array.from(new Set([env?.HYPERSNAP_ENDPOINT, env?.HUB_ENDPOINT].filter((s): s is string => !!s).map(trim)));
}

/** `HYPERSNAP_FALLBACK_ENDPOINTS` as a list, in order, minus anything already primary. */
export function hypersnapFallbacks(env: EndpointEnv): string[] {
  const primaries = new Set(hypersnapPrimaries(env));
  const list = String(env?.HYPERSNAP_FALLBACK_ENDPOINTS ?? '').split(',').map(trim).filter(Boolean);
  return Array.from(new Set(list)).filter(e => !primaries.has(e));
}

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

function shouldFailOver(method: string, status: number): boolean {
  if (method === 'GET' || method === 'HEAD') return status === 429 || status >= 500;
  return isGatewayStatus(status);
}

export interface FailoverFetchOptions {
  primaries: string[];
  fallbacks: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * A `fetch` that fails over between Hypersnap nodes. With no fallbacks
 * configured the only difference from plain fetch is the per-attempt timeout.
 */
export function failoverFetch(opts: FailoverFetchOptions): typeof fetch {
  const base = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const primaries = opts.primaries.map(trim);
  const fallbacks = opts.fallbacks.map(trim);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Callers in this codebase pass a string URL. A Request object carries a
    // one-shot body we could not replay, so it is not ours to fail over.
    if (typeof input !== 'string' && !(input instanceof URL)) return base(input, init);
    const url = String(input);
    const primary = primaries.find(p => url === p || url.startsWith(`${p}/`));
    if (!primary) return base(input, init);

    const rest = url.slice(primary.length);
    const method = (init?.method ?? 'GET').toUpperCase();
    const timeoutMs = method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;

    const nodes = [primary, ...fallbacks.filter(f => f !== primary)];
    const t = now();
    const up = nodes.filter(n => (coolingDown.get(n) ?? 0) <= t);
    const order = up.length > 0 ? [...up, ...nodes.filter(n => !up.includes(n))] : nodes;

    let lastError: unknown = null;
    for (let i = 0; i < order.length; i++) {
      const node = order[i];
      const isLast = i === order.length - 1;
      try {
        // A caller's own signal wins; otherwise bound the attempt so a node
        // that accepts the connection and never answers still fails over.
        const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
        const res = await base(`${node}${rest}`, { ...init, signal });
        if (!shouldFailOver(method, res.status)) {
          coolingDown.delete(node);
          return res;
        }
        coolingDown.set(node, now() + COOLDOWN_MS);
        if (isLast) return res;
        console.warn(`[Hypersnap] ${node} answered ${res.status} on ${method} ${rest.split('?')[0]}; trying the next node`);
        // Free the connection: nobody will read this body.
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        coolingDown.set(node, now() + COOLDOWN_MS);
        lastError = err;
        if (!isLast) {
          console.warn(`[Hypersnap] ${node} failed on ${method} ${rest.split('?')[0]}: ${(err as Error)?.message ?? err}; trying the next node`);
        }
      }
    }
    // The last node either returned above or threw into `lastError`.
    throw lastError;
  }) as typeof fetch;
}

/** The failover fetch for this deployment's nodes. Pass it wherever a Hypersnap URL is fetched. */
export function hypersnapFetch(env: EndpointEnv, fetchImpl?: typeof fetch): typeof fetch {
  return failoverFetch({
    primaries: hypersnapPrimaries(env),
    fallbacks: hypersnapFallbacks(env),
    fetchImpl,
  });
}
