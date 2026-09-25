/**
 * Per-person KV entries keyed by fid (docs/specs/account-root.md §5):
 *   - KV_USER_POINTS   `<key>`           QP balances
 *   - KV_USER_PROFILES `settings:<key>`  user settings
 *
 * The `kv` phase COPIES each fid-keyed entry to its account-id key when the
 * account-id key does not exist yet. Copy-only: the fid entry stays, so the
 * phase loses nothing, needs no reverse, and is safe to re-run (an entry
 * already copied, or written by new code after the cutover, is left alone).
 */

import { ACCOUNT_ID_MIN } from './migrationSql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type KvTarget = 'points' | 'settings';

const TARGETS: Record<KvTarget, { binding: string; prefix: string }> = {
  points: { binding: 'KV_USER_POINTS', prefix: '' },
  settings: { binding: 'KV_USER_PROFILES', prefix: 'settings:' },
};

export interface KvReport {
  phase: 'kv';
  target: KvTarget;
  dryRun: boolean;
  scanned: number;
  copied: number;
  already: number;
  unmapped: number;
  nextCursor: string | null;
  done: boolean;
}

export async function kvPhase(env: Env, o: { target: KvTarget; dryRun: boolean; cursor?: string; limit: number }): Promise<KvReport> {
  const t = TARGETS[o.target];
  const kv = env[t.binding];
  const r: KvReport = { phase: 'kv', target: o.target, dryRun: o.dryRun, scanned: 0, copied: 0, already: 0, unmapped: 0, nextCursor: null, done: false };
  if (!kv) throw new Error(`${t.binding} is not bound`);
  const page = await kv.list({ prefix: t.prefix || undefined, cursor: o.cursor, limit: Math.min(1000, Math.max(1, o.limit)) }) as {
    keys: Array<{ name: string }>; list_complete: boolean; cursor?: string;
  };
  for (const { name } of page.keys) {
    const rest = name.slice(t.prefix.length);
    if (!/^\d{1,13}$/.test(rest)) continue;
    const key = Number(rest);
    if (key >= ACCOUNT_ID_MIN) continue; // already an account key
    r.scanned++;
    const acc = await env.DB.prepare('SELECT id FROM accounts WHERE legacy_key = ?').bind(key).first() as { id: number } | null;
    if (!acc) { r.unmapped++; continue; }
    const target = `${t.prefix}${acc.id}`;
    if (await kv.get(target) !== null) { r.already++; continue; }
    if (!o.dryRun) {
      const value = await kv.get(name);
      if (value !== null) await kv.put(target, value);
    }
    r.copied++;
  }
  r.nextCursor = page.list_complete ? null : (page.cursor ?? null);
  r.done = r.nextCursor === null;
  return r;
}
