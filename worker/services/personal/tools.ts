/**
 * Personal MCP tools, P0 (docs/specs/personal-mcp.md §2): read-only, for an
 * agent acting for one person under a grant. Agents never answer.
 *
 * Every tool loads the owner's record cut to the grant (record.ts), opens
 * only the sealed rows it returns, and logs one grant_reads row with the
 * audiences of the answers whose content it served. `derived` grants get
 * get_profile and get_context's derived view (scores, counts, gaps); the raw
 * tools refuse them.
 */

import {
  buildContext, candidatesOf, cosine, embedText, groupOf, measuredFor, positionsOf, recallByProbes, withinCeiling,
  GROUPS, type Candidate, type Grant, type Group,
} from './context';
import { MAX_CANDIDATES, selectRelevant } from './select';
import { loadOwnerRecord, openSealed, type LoadedRecord } from './record';
import { logRead } from './GrantService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: 'get_context',
    title: "The owner's context for a decision",
    description:
      'Start here when helping the owner decide something (who to vote for, where to apply, what to build next). ' +
      'Returns the owner\'s own answers that bear on the decision, grouped as values / preferences / beliefs / facts / goals / recent, ' +
      'each dated with any change of mind, plus their quiz-measured traits and `gaps`: what they have not answered that would change the advice. ' +
      'Ask the owner about gaps rather than guessing. ' +
      'The decision and context are sent to qbase\'s model provider to pick what is relevant: keep them general and leave out names of other people.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'The decision, in a sentence: "which job offer should I take". No names of other people.', maxLength: 500 },
        context: { type: 'string', description: 'Optional specifics that sharpen what is relevant. Sent to qbase\'s model provider; keep it general.', maxLength: 1000 },
      },
      required: ['decision'],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY, idempotentHint: false },
  },
  {
    name: 'search_my_positions',
    title: "Search the owner's answers",
    description: 'Lower-level search: the owner\'s answered questions nearest a topic or phrase, with their latest answer and date. Prefer get_context for decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300 },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_answer_history',
    title: 'Every answer the owner gave on one question',
    description: 'All of the owner\'s answers on a question, newest first. Answers are append-only, so a different later answer is a change of mind.',
    inputSchema: {
      type: 'object',
      properties: { question_id: { type: 'string' } },
      required: ['question_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_my_answers',
    title: "List the owner's answers",
    description: 'The owner\'s latest answer per question, newest first: feed answers and quiz items by default; `source` narrows to one.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date; only answers on or after it.' },
        audience: { type: 'string', enum: ['Public', 'Anon', 'Secret'] },
        source: { type: 'string', enum: ['feed', 'quiz', 'all'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_profile',
    title: "The owner's derived profile",
    description:
      'Quiz-measured traits (values radar, bartlet player type, apperception learning style) with scores, ' +
      'how many answers the owner has per kind and topic, and (if this key may read answers) their stated goals. ' +
      'Each item carries provenance: measured (a quiz scored it) or stated (they said it).',
    inputSchema: {
      type: 'object',
      properties: {
        domains: { type: 'array', items: { type: 'string' }, description: 'Optional topics to narrow the counts to.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

export class ToolError extends Error {}

export interface ToolResult {
  data: unknown;
  /** Audiences of the answers whose content `data` carries (for the read log). */
  served: string[];
}

function requireRaw(grant: Grant, tool: string) {
  if (grant.disclosure !== 'raw') {
    throw new ToolError(`${tool} returns answers; this key may only read the derived profile (get_profile, get_context).`);
  }
}

function str(v: unknown, name: string, max: number, required = true): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${name} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new ToolError(`${name}: at most ${max} characters`);
  return s;
}

/** Audiences served: every opened row on the questions returned (conservative: counts unchanged repeats too). */
function servedOn(record: LoadedRecord, grant: Grant, qIds: Iterable<string>): string[] {
  const want = new Set(qIds);
  return record.answers
    .filter((a) => want.has(a.q_id) && a.opened && withinCeiling(a.audience, grant.ceiling))
    .map((a) => a.audience);
}

async function embedAll(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const r = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts.slice(i, i + 100) }) as { data: number[][] };
    out.push(...r.data);
  }
  return out;
}

async function getContext(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  const decision = str(args.decision, 'decision', 500)!;
  const context = str(args.context, 'context', 1000, false);
  const record = await loadOwnerRecord(env, ownerKey, grant);
  let candidates: Candidate[] = candidatesOf(record, grant);
  if (candidates.length > MAX_CANDIDATES) {
    const vecs = await embedAll(env, [context ? `${decision} ${context}` : decision, ...candidates.map((c) => c.text)]);
    candidates = recallByProbes(candidates, new Map(candidates.map((c, i) => [c.id, vecs[i + 1]])), [vecs[0]], MAX_CANDIDATES);
  }
  const sel = await selectRelevant(decision, context, candidates, { apiKey: env.OPENROUTER_API_KEY, model: env.PERSONAL_CONTEXT_MODEL });
  if (sel.error) console.warn('[personal] selection fell back:', sel.error);
  const picked = sel.selected.map((s) => s.id);
  if (grant.disclosure === 'raw') await openSealed(env, record, picked);
  const bundle = buildContext({ decision, record, grant, selected: sel.selected, gaps: sel.gaps, selection: sel.via });
  const served = grant.disclosure === 'raw'
    ? servedOn(record, grant, Object.values(bundle.groups ?? {}).flat().map((p) => p.question_id))
    : [];
  return { data: bundle, served };
}

async function searchMyPositions(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  requireRaw(grant, 'search_my_positions');
  const query = str(args.query, 'query', 300)!;
  const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10) || 10));
  const record = await loadOwnerRecord(env, ownerKey, grant);
  const { positions } = positionsOf(record, grant);
  if (positions.length === 0) return { data: { query, results: [] }, served: [] };
  const vecs = await embedAll(env, [query, ...positions.map((p) => embedText(p.stem, p.options))]);
  const top = positions
    .map((p, i) => ({ p, score: cosine(vecs[0], vecs[i + 1]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  await openSealed(env, record, top.map((t) => t.p.question_id));
  // Re-shape after opening so sealed values and their history are filled in.
  const opened = new Map(positionsOf(record, grant).positions.map((p) => [p.question_id, p]));
  const results = top.map((t) => ({ ...opened.get(t.p.question_id)!, similarity: Math.round(t.score * 1000) / 1000 }));
  return { data: { query, results }, served: servedOn(record, grant, top.map((t) => t.p.question_id)) };
}

async function getAnswerHistory(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  requireRaw(grant, 'get_answer_history');
  const qid = str(args.question_id, 'question_id', 200)!;
  const record = await loadOwnerRecord(env, ownerKey, grant);
  const rows = record.answers.filter((a) => a.q_id === qid && withinCeiling(a.audience, grant.ceiling));
  if (rows.length === 0) return { data: { question_id: qid, answers: [] }, served: [] };
  await openSealed(env, record, [qid]);
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const first = rows[0];
  return {
    data: {
      question_id: qid, stem: first.stem.trim(), question_type: first.question_type, group: groupOf(first.taxonomy),
      ...(first.options?.length ? { options: first.options } : {}),
      answers: rows.map((a) => ({ answer: a.value, reasoning: a.reasoning, at: a.created_at, tier: a.audience === 'Public' || a.audience === 'Anon' ? a.audience : 'Secret', source: a.source, wave_id: a.poll_id })),
    },
    served: rows.filter((a) => a.opened).map((a) => a.audience),
  };
}

async function listMyAnswersTool(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  requireRaw(grant, 'list_my_answers');
  const since = str(args.since, 'since', 40, false);
  if (since && Number.isNaN(Date.parse(since))) throw new ToolError('since must be an ISO date');
  const audience = str(args.audience, 'audience', 10, false);
  if (audience && !['Public', 'Anon', 'Secret'].includes(audience)) throw new ToolError('audience must be Public, Anon or Secret');
  const source = str(args.source, 'source', 10, false) ?? 'all';
  if (!['feed', 'quiz', 'all'].includes(source)) throw new ToolError('source must be feed, quiz or all');
  const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50) || 50));

  const record = await loadOwnerRecord(env, ownerKey, grant);
  const sinceIso = since ? new Date(since).toISOString() : undefined;
  const keep = positionsOf(record, grant, Date.now(), { includeStale: true }).positions
    .filter((p) => source === 'all' || p.source === source)
    .filter((p) => !audience || p.tier === audience)
    .filter((p) => !sinceIso || p.answered_at >= sinceIso)
    .sort((a, b) => b.answered_at.localeCompare(a.answered_at))
    .slice(0, limit);
  await openSealed(env, record, keep.map((p) => p.question_id));
  const opened = new Map(positionsOf(record, grant, Date.now(), { includeStale: true }).positions.map((p) => [p.question_id, p]));
  return {
    data: { answers: keep.map((p) => opened.get(p.question_id)!) },
    served: servedOn(record, grant, keep.map((p) => p.question_id)),
  };
}

async function getProfile(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  const domains = Array.isArray(args.domains) ? (args.domains as unknown[]).filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase()) : [];
  const record = await loadOwnerRecord(env, ownerKey, grant);
  const { positions, stale } = positionsOf(record, grant, Date.now(), { includeStale: true });
  const byQ = new Map(record.answers.map((a) => [a.q_id, a]));

  const counts: Partial<Record<Group, number>> = {};
  const topics = new Map<string, number>();
  for (const p of positions) {
    const t = (byQ.get(p.question_id)?.taxonomy?.topics ?? []).map((s) => s.toLowerCase());
    if (domains.length && !t.some((x) => domains.includes(x))) continue;
    counts[p.group] = (counts[p.group] ?? 0) + 1;
    for (const x of t) topics.set(x, (topics.get(x) ?? 0) + 1);
  }
  const askedTopics = new Map<string, number>();
  for (const q of record.authored) for (const x of (q.taxonomy?.topics ?? []).map((s) => s.toLowerCase())) askedTopics.set(x, (askedTopics.get(x) ?? 0) + 1);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([topic, n]) => ({ topic, n }));

  const data: Record<string, unknown> = {
    measured: measuredFor(record, grant),
    coverage: {
      by_group: Object.fromEntries(GROUPS.filter((g) => counts[g]).map((g) => [g, counts[g]])),
      top_topics: top(topics),
      answered_total: positions.length,
      stale_recent: stale,
    },
    // Questions they asked show what they're learning or deciding (portable-context §expertise).
    asked: { total: record.authored.length, top_topics: top(askedTopics) },
  };
  let served: string[] = [];
  if (grant.disclosure === 'raw') {
    const goals = positions.filter((p) => p.group === 'goals');
    await openSealed(env, record, goals.map((g) => g.question_id));
    const opened = new Map(positionsOf(record, grant, Date.now(), { includeStale: true }).positions.map((p) => [p.question_id, p]));
    data.goals = goals.map((g) => opened.get(g.question_id)!);
    served = servedOn(record, grant, goals.map((g) => g.question_id));
  }
  return { data, served };
}

const HANDLERS: Record<string, (env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>) => Promise<ToolResult>> = {
  get_context: getContext,
  search_my_positions: searchMyPositions,
  get_answer_history: getAnswerHistory,
  list_my_answers: listMyAnswersTool,
  get_profile: getProfile,
};

/** Run a tool and log the read. Throws ToolError for bad input / disclosure. */
export async function callTool(env: Env, ownerKey: number, grant: Grant, name: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`unknown tool: ${name}`);
  const { data, served } = await handler(env, ownerKey, grant, args ?? {});
  await logRead(env, grant.id, name, served);
  return data;
}
