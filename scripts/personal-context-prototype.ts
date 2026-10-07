/**
 * get_context prototype against one account's record in prod D1, read-only
 * (docs/specs/personal-mcp.md §3.6, §5 P0).
 *
 * Runs the same pure core the /mcp tool runs (worker/services/personal/context.ts)
 * over rows loaded with SELECTs through wrangler. Secret values stay sealed
 * here: opening them needs the KEK and Q Storage, which only the worker uses,
 * so Secret positions show `{ sealed: true }` and are ranked by their stems.
 *
 * Run:  npx --yes tsx scripts/personal-context-prototype.ts --account=<id> "<decision>" ["<decision>" ...]
 *         [--ceiling=Public|Anon|Secret] [--disclosure=raw|derived] [--context=<text>] [--model=<openrouter id>] [--out=<path.json>]
 * Env (.dev.vars, or --env=<path>): OPENROUTER_API_KEY; for records over MAX_CANDIDATES also Workers AI:
 *   CLOUDFLARE_API_TOKEN, else wrangler's login, else WORKERS_AI_API_KEY;
 *   CLOUDFLARE_ACCOUNT_ID (default: qbase's).
 */

import { config } from 'dotenv';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildContext, candidatesOf, recallByProbes, type Grant, type OwnerRecord, type Tier } from '../worker/services/personal/context';
import { MAX_CANDIDATES, selectRelevant } from '../worker/services/personal/select';
import type { QuestionTaxonomy } from '../worker/services/taxonomy/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
config({ path: arg('env') ?? [resolve(__dirname, '../.dev.vars'), resolve(__dirname, '../../qbase/.dev.vars')].find(existsSync) });

const account = Number(arg('account'));
const decisions = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!Number.isSafeInteger(account) || decisions.length === 0) {
  console.error('usage: tsx scripts/personal-context-prototype.ts --account=<id> "<decision>" [...]');
  process.exit(1);
}
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? '09f3be5733db9856bd5f3b318e4a35de';

type Row = Record<string, unknown>;

function d1(sql: string): Row[] {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('read-only: one SELECT per call');
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'prod-qbase', '--remote', '--config', 'wrangler.jsonc', '--json', '--command', sql], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20,
  });
  return (JSON.parse(out) as Array<{ results: Row[] }>)[0].results;
}

function cfToken(): string {
  // wrangler's own login before .dev.vars: the latter's Workers AI key may predate a rotation.
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const toml = resolve(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  const m = existsSync(toml) ? readFileSync(toml, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/) : null;
  if (m) return m[1];
  if (process.env.WORKERS_AI_API_KEY) return process.env.WORKERS_AI_API_KEY;
  throw new Error('no Workers AI token');
}

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/baai/bge-base-en-v1.5`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts.slice(i, i + 96) }),
    });
    if (!res.ok) throw new Error(`workers ai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    out.push(...((await res.json()) as { result: { data: number[][] } }).result.data);
  }
  return out;
}

const parse = <T>(s: unknown): T | null => {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};

function loadRecord(key: number): OwnerRecord {
  const answers = d1(`SELECT a.id, a.q_id, a.value, a.reasoning, a.audience, a.created_at, a.poll_id, a.quiz_completion_id,
                             q.stem, q.type, q.taxonomy, q.a_options, q.scale_config
                        FROM Answers a JOIN queries q ON q.id = a.q_id WHERE a.user_id = ${key}`);
  const authored = d1(`SELECT id, stem, created_at, taxonomy FROM queries WHERE coiner_id = ${key} OR owner_id = ${key}`);
  const measured = d1(`SELECT quiz_id, completed_at, result_category, scores, visibility FROM quiz_completions WHERE user_id = ${key} ORDER BY completed_at DESC`);
  const latestPerQuiz = new Map<string, Row>();
  for (const m of measured) if (!latestPerQuiz.has(String(m.quiz_id))) latestPerQuiz.set(String(m.quiz_id), m);
  return {
    answers: answers.map((r) => ({
      id: String(r.id), q_id: String(r.q_id), stem: String(r.stem), question_type: (r.type as string) ?? null,
      options: r.type === 'mc' || r.type === 'checkbox' ? parse<string[]>(r.a_options) : null,
      scale_config: parse(r.scale_config),
      value: r.audience === 'Public' ? r.value : { sealed: true },
      reasoning: (r.reasoning as string) || null, audience: String(r.audience), created_at: String(r.created_at),
      poll_id: (r.poll_id as string) ?? null, source: r.quiz_completion_id ? 'quiz' : 'feed',
      taxonomy: parse<Partial<QuestionTaxonomy>>(r.taxonomy),
    })),
    authored: authored.map((r) => ({ id: String(r.id), stem: String(r.stem), created_at: String(r.created_at), taxonomy: parse(r.taxonomy) })),
    measured: [...latestPerQuiz.values()].map((m) => ({
      quiz_id: String(m.quiz_id), completed_at: new Date(Number(m.completed_at)).toISOString(),
      result: (m.result_category as string) ?? null, scores: parse(m.scores), visibility: String(m.visibility ?? 'private'),
    })),
  };
}

const record = loadRecord(account);
const grant: Grant = {
  id: 'prototype', disclosure: (arg('disclosure', 'raw') as Grant['disclosure']), ceiling: arg('ceiling', 'Secret') as Tier, domains: '*',
};
console.error(`record: ${record.answers.length} answers, ${record.authored.length} authored, ${record.measured.length} quiz results`);

const bundles = [];
for (const decision of decisions) {
  const t0 = Date.now();
  let candidates = candidatesOf(record, grant);
  if (candidates.length > MAX_CANDIDATES) {
    const vecs = await embed([decision, ...candidates.map((c) => c.text)]);
    const vectors = new Map(candidates.map((c, i) => [c.id, vecs[i + 1]]));
    candidates = recallByProbes(candidates, vectors, [vecs[0]], MAX_CANDIDATES);
  }
  const sel = await selectRelevant(decision, arg('context'), candidates, { apiKey: process.env.OPENROUTER_API_KEY, model: arg('model') });
  const bundle = buildContext({ decision, record, grant, selected: sel.selected, gaps: sel.gaps, selection: sel.via });
  console.error(`${decision}: ${candidates.length} candidates, selection ${sel.via}${sel.error ? ` (${sel.error})` : ''}, ${sel.selected.length} picked, ${Date.now() - t0} ms`);
  bundles.push(bundle);
}
const json = JSON.stringify(bundles.length === 1 ? bundles[0] : bundles, null, 2);
if (arg('out')) writeFileSync(arg('out')!, json);
console.log(json);
