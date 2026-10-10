/**
 * Personal MCP tools (docs/specs/personal-mcp.md §2), for an agent acting for
 * one person under a grant. P0 reads; P1 asks (ask_owner, get_asked): the
 * agent writes questions to the owner's inbox and reads back what the owner
 * answered. Agents never answer.
 *
 * Every tool loads the owner's record cut to the grant (record.ts), opens
 * only the sealed rows it returns, and logs one grant_reads row with the
 * audiences of the answers whose content it served. `derived` grants get
 * get_profile and get_context's derived view (scores, counts, gaps); the raw
 * tools refuse them.
 */

import {
  buildContext, candidatesOf, cosine, embedText, groupOf, inDomains, measuredFor, positionsOf, recallByProbes, withinCeiling,
  GROUPS, type Candidate, type Grant, type Group,
} from './context';
import { MAX_CANDIDATES, selectRelevant } from './select';
import { loadOwnerRecord, openSealed, type LoadedRecord } from './record';
import { logRead } from './GrantService';
import { AskError, MAX_ITEMS, MAX_PENDING_PER_GRANT, createAsk, listAsks, loadOwnerQuestions, resolveQuestions, type OpenedAsk } from './AskService';
import { MAX_UNCONFIRMED_PER_GRANT, NUDGE_UNCONFIRMED, RELAYS_PER_HOUR, countUnconfirmed, recordRelay } from './RelayService';
import { RateLimitService } from '../RateLimitService';
import { VectorService } from '../VectorService';
import { parseOptions } from '../SnapService';

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
  {
    name: 'ask_owner',
    title: 'Ask the owner',
    description:
      'Put a short set of questions (1–' + MAX_ITEMS + ') in the owner\'s qbase inbox for a decision you are helping with; they answer when they next open qbase, not now. ' +
      'Use it for answers that should outlive this session (positions, facts, preferences that will matter again) or that the owner may want kept private, not for quick clarifications you can ask in chat. ' +
      'It returns `url`: when the owner is in the conversation, show it to them; they answer there and come back. ' +
      'Prefer general questions anyone could answer ("how much do you value remote work?") over specific ones, and put the specifics (names, companies, dates) in `note`. ' +
      'An item is {question_id} for an existing question (from find_questions, get_context or get_answer_history) or {stem, type, options?, scale?} for a new one; ' +
      'check find_questions before writing a new one. ' +
      'a new question is visible only to the owner and needs a key that can read Secret. The owner chooses who sees each answer. Read the answers later with get_asked. ' +
      'At most ' + MAX_PENDING_PER_GRANT + ' unanswered asks per key.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', maxLength: 500, description: 'The decision this serves, in a sentence. Shown to the owner.' },
        why_needed: { type: 'string', maxLength: 500, description: 'Why their answer changes your advice. Shown to the owner.' },
        force: { type: 'boolean', description: 'Write new stems even when one closely matches an existing public question (you were told which).' },
        note: { type: 'string', maxLength: 1000, description: 'Optional specifics (who, where, when) the general questions leave out. Shown only to the owner.' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              question_id: { type: 'string', description: 'An existing question to ask instead of writing a new one.' },
              stem: { type: 'string', maxLength: 300 },
              type: { type: 'string', enum: ['text', 'mc', 'checkbox', 'scale'], default: 'text' },
              options: { type: 'array', items: { type: 'string', maxLength: 120 }, minItems: 2, maxItems: 10, description: 'mc / checkbox only.' },
              scale: {
                type: 'object',
                properties: {
                  min: { type: 'integer', default: 1 },
                  max: { type: 'integer', default: 5 },
                  labels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Labels by point, e.g. {"1": "never", "5": "always"}.' },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['decision', 'why_needed', 'items'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_asked',
    title: 'What the owner answered',
    description:
      'Your asks (this key\'s only), newest first: pending, answered or declined, each item with the owner\'s answer once given. ' +
      'An answer the owner gave at a tier above what this key may read stays pending to you.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'answered', 'declined', 'all'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'record_answer',
    title: 'Record what the owner just told you',
    description:
      'When the owner answers a question in this conversation, record their answer here so it outlives the session. ' +
      'Relay exactly what they said, word for word for text: never infer, summarise, paraphrase or fill in an answer they didn\'t give. ' +
      'If they haven\'t said it, ask them (in chat, or with ask_owner). ' +
      'The answer is saved Secret and marked as recorded by you until the owner confirms, edits or deletes it in their qbase inbox; only they can make it Anon or Public. ' +
      'Name the question with question_id (from find_questions, get_context or get_answer_history), or ask_id + position for an item of one of your asks, ' +
      'or {stem, type, options?, scale?} for a new one only when find_questions has nothing that asks the same (visible only to the owner; an exact repeat is reused). ' +
      '`answer`: text as they said it; for mc one of the options exactly; for checkbox a list of options; for scale a whole number in range. ' +
      'Predictions can\'t be recorded: ask them with ask_owner. Needs a key that can read Secret. ' +
      'After recording, tell the owner what you saved, in a line, so they can correct it on the spot. At most ' + RELAYS_PER_HOUR + ' an hour.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'An existing question.' },
        ask_id: { type: 'string', description: 'One of your asks (from ask_owner / get_asked), with position.' },
        position: { type: 'integer', minimum: 0, description: 'The item\'s index in the ask, 0-based.' },
        stem: { type: 'string', maxLength: 300, description: 'A new question, worded generally (no names); only the owner sees it.' },
        type: { type: 'string', enum: ['text', 'mc', 'checkbox', 'scale'], default: 'text' },
        options: { type: 'array', items: { type: 'string', maxLength: 120 }, minItems: 2, maxItems: 10, description: 'mc / checkbox only.' },
        scale: {
          type: 'object',
          properties: {
            min: { type: 'integer', default: 1 },
            max: { type: 'integer', default: 5 },
            labels: { type: 'object', additionalProperties: { type: 'string' } },
          },
          additionalProperties: false,
        },
        answer: {
          description: 'The owner\'s answer, as they gave it.',
          anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'integer' }, { type: 'array', items: { type: 'string' } }],
        },
        reasoning: { type: 'string', maxLength: 2000, description: 'Why, only if the owner said why, in their words.' },
        force: { type: 'boolean', description: 'Write a new stem even when it closely matches an existing public question (you were told which).' },
      },
      required: ['answer'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'find_questions',
    title: 'Find existing questions',
    description:
      'Public qbase questions nearest a topic or wording, before you write a new one for ask_owner or record_answer. ' +
      'Reusing an existing question (by question_id) keeps the owner\'s answer comparable with everyone else\'s and over time; ' +
      'write a new stem only when none of these asks the same thing. Returns each question\'s type and options, how many people answered it publicly, ' +
      'and (for keys that read answers) whether the owner already has. For keys that read Secret it also returns questions written for the owner ' +
      'earlier (owner_only: true), so you can ask the same one again rather than a rewording.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: 'The question you were about to ask, or its topic.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
      required: ['query'],
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

/** How close (cosine, bge-base) an owner-only question must be to the decision to be included. */
const SEALED_MIN_SIMILARITY = 0.6;
const SEALED_MAX = 8;

/**
 * Owner-only positions bearing on the decision, ranked inside Cloudflare (Workers AI embeddings,
 * computed per call and never stored), since their stems can't go to the third-party selector.
 */
async function rankSealed(env: Env, record: LoadedRecord, grant: Grant, probe: string): Promise<Array<{ id: string; why: string }>> {
  const sealed = new Set(record.answers.filter((a) => a.stem_sealed).map((a) => a.q_id));
  const positions = positionsOf(record, grant).positions.filter((p) => sealed.has(p.question_id));
  if (positions.length === 0) return [];
  const vecs = await embedAll(env, [probe, ...positions.map((p) => embedText(p.stem, p.options))]);
  return positions
    .map((p, i) => ({ p, score: cosine(vecs[0], vecs[i + 1]) }))
    .filter((x) => x.score >= SEALED_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEALED_MAX)
    .map((x) => ({ id: x.p.question_id, why: `you asked the owner this; close to the decision (similarity ${Math.round(x.score * 100) / 100})` }));
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
  // Owner-only questions never reach the selector (sealed stems); rank them here with Workers AI instead.
  const sealedPicks = await rankSealed(env, record, grant, context ? `${decision} ${context}` : decision);
  const picked = [...sel.selected, ...sealedPicks].map((s) => s.id);
  if (grant.disclosure === 'raw') await openSealed(env, record, picked);
  const bundle = buildContext({ decision, record, grant, selected: [...sel.selected, ...sealedPicks], gaps: sel.gaps, selection: sel.via });
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
      answers: rows.map((a) => ({
        answer: a.value, reasoning: a.reasoning, at: a.created_at, tier: a.audience === 'Public' || a.audience === 'Anon' ? a.audience : 'Secret',
        source: a.source, wave_id: a.poll_id, provenance: a.relayed ? 'relayed' : 'stated',
      })),
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

/** At or above this a new stem is probably an existing public question reworded (bge-base cosine). */
const REUSE_SIMILARITY = 0.9;

/**
 * New stems an agent wrote that closely match a public question (exact repeats excluded: those are
 * reused automatically). Agents are told to reuse a canonical question; this makes it the default:
 * the tool refuses once with the match, and `force: true` writes the new stem anyway. Fails open.
 */
async function nearPublic(env: Env, items: Array<Record<string, unknown>>): Promise<Array<{ stem: string; question_id: string; existing: string; similarity: number }>> {
  const out: Array<{ stem: string; question_id: string; existing: string; similarity: number }> = [];
  try {
    const vs = VectorService.fromEnv(env);
    for (const it of items) {
      if (typeof it.question_id === 'string' && it.question_id) continue;
      if (typeof it.stem !== 'string' || !it.stem.trim()) continue;
      const top = (await vs.searchSimilar(await vs.vectorize(it.stem), 'q', 3)).filter((m) => m.score >= REUSE_SIMILARITY);
      for (const m of top) {
        const q = await env.DB.prepare('SELECT stem, type FROM queries WHERE id = ?').bind(m.id).first() as { stem: string; type: string } | null;
        if (!q || !['text', 'mc', 'checkbox', 'scale'].includes(q.type)) continue;
        if (q.stem.trim().toLowerCase() === it.stem.trim().toLowerCase()) continue;
        out.push({ stem: it.stem.trim(), question_id: m.id, existing: q.stem.trim(), similarity: Math.round(m.score * 1000) / 1000 });
        break;
      }
    }
  } catch (e) {
    console.warn('[personal] reuse check unavailable:', e instanceof Error ? e.message : e);
  }
  return out;
}

function reuseRefusal(near: Awaited<ReturnType<typeof nearPublic>>): ToolError {
  return new ToolError(
    'These read like existing public questions; reuse them by question_id so the owner\'s answer counts alongside everyone\'s, ' +
    'or pass force: true to write yours anyway: ' +
    near.map((n) => `"${n.stem}" ≈ ${n.question_id} "${n.existing}" (${n.similarity})`).join('; '),
  );
}

async function askOwner(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  // Counted from what this key can see, not the stored status, for the reason in keyView.
  const { asks } = await keyView(env, ownerKey, grant, await listAsks(env, { ownerKey, grantId: grant.id }, 50), false);
  if (asks.filter((a) => a.status === 'pending').length >= MAX_PENDING_PER_GRANT) {
    throw new ToolError(`this key already has ${MAX_PENDING_PER_GRANT} unanswered asks; wait for the owner or check get_asked`);
  }
  if (args.force !== true && Array.isArray(args.items)) {
    const near = await nearPublic(env, args.items.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object'));
    if (near.length) throw reuseRefusal(near);
  }
  try {
    const created = await createAsk(env, ownerKey, grant.id, {
      decision: args.decision, why_needed: args.why_needed, note: args.note, items: args.items,
    }, { ownerOnly: grant.ceiling === 'Secret', topics: grant.domains === '*' ? undefined : grant.domains });
    return {
      data: {
        ...created,
        status: 'pending',
        url: `${ctx.origin}/me/inbox/${created.ask_id}`,
        next: 'If the owner is in this conversation, show them `url`: they answer there in one click (choosing who sees each answer) and come back; ' +
          'then read it with get_asked. Otherwise it waits in their qbase inbox; check get_asked later, don\'t wait on it.',
      },
      served: [],
    };
  } catch (e) {
    if (e instanceof AskError) throw new ToolError(e.message);
    throw e;
  }
}

/**
 * This key's view of its asks. An item the owner answered at a tier above the key's ceiling
 * reads as pending, never as "answered, withheld", and the ask's status follows its items:
 * when an above-ceiling answer was given is itself a link from this key to an Anon row.
 * `open` opens the answers' values (raw keys only).
 */
async function keyView(env: Env, ownerKey: number, grant: Grant, asks: OpenedAsk[], open: boolean) {
  const served: string[] = [];
  if (asks.length === 0) return { asks: [], served };

  // The key asked these itself, so its domains don't hide the answers; its ceiling and disclosure still apply.
  const scoped: Grant = { ...grant, domains: '*' };
  const qIds = [...new Set(asks.flatMap((a) => a.items.map((i) => i.question_id)))];
  const questions = await resolveQuestions(env, ownerKey, qIds);
  const record = await loadOwnerRecord(env, ownerKey, scoped);

  const latestSince = (qid: string, sinceIso: string) => record.answers
    .filter((a) => a.q_id === qid && a.created_at >= sinceIso && withinCeiling(a.audience, grant.ceiling))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];

  const raw = open && grant.disclosure === 'raw';
  if (raw) {
    const toOpen = new Set<string>();
    for (const ask of asks) {
      const since = new Date(ask.created_at).toISOString();
      for (const it of ask.items) if (it.answered && latestSince(it.question_id, since)) toOpen.add(it.question_id);
    }
    await openSealed(env, record, toOpen);
  }

  const out = asks.map((ask) => {
    const since = new Date(ask.created_at).toISOString();
    const items = ask.items.map((it) => {
      const q = questions.get(it.question_id);
      const base = { question_id: it.question_id, stem: q?.stem ?? null, owner_only: q?.owner_only ?? false };
      if (it.skipped) return { ...base, state: 'skipped' };
      const a = it.answered ? latestSince(it.question_id, since) : undefined;
      if (!a) return { ...base, state: 'pending' };
      if (!raw) return { ...base, state: 'answered', withheld: 'this key reads quiz results and counts only, not answers' };
      if (!a.opened) return { ...base, state: 'pending' };
      served.push(a.audience);
      return {
        ...base, state: 'answered', answer: a.value, reasoning: a.reasoning, at: a.created_at,
        tier: a.audience === 'Public' || a.audience === 'Anon' ? a.audience : 'Secret', provenance: a.relayed ? 'relayed' : 'stated',
      };
    });
    const status = ask.status === 'declined' ? 'declined' : items.every((it) => it.state !== 'pending') ? 'answered' : 'pending';
    return { ask_id: ask.id, status, asked_at: since, decision: ask.decision, items };
  });
  return { asks: out, served };
}

async function getAsked(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  const status = str(args.status, 'status', 10, false) ?? 'all';
  if (!['pending', 'answered', 'declined', 'all'].includes(status)) throw new ToolError('status must be pending, answered, declined or all');
  const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10));
  // Filtered on the key's view, not in SQL (keyView).
  const listed = await listAsks(env, { ownerKey, grantId: grant.id, status: status === 'declined' ? 'declined' : 'all' }, 50);
  const { asks, served } = await keyView(env, ownerKey, grant, listed, true);
  const filtered = status === 'all' ? asks : asks.filter((a) => a.status === status);
  return { data: { asks: filtered.slice(0, limit) }, served };
}

async function recordAnswer(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  if (grant.disclosure !== 'raw' || grant.ceiling !== 'Secret') {
    throw new ToolError('record_answer needs a key that can read Secret answers: a relayed answer is saved Secret, and a key records only what it can read back.');
  }
  for (const k of ['audience', 'tier']) {
    if (args[k] !== undefined && args[k] !== 'Secret') {
      throw new ToolError('a relayed answer is always Secret; only the owner can make it Anon or Public, from their inbox.');
    }
  }
  const waiting = await countUnconfirmed(env, { ownerKey, grantId: grant.id });
  if (waiting >= MAX_UNCONFIRMED_PER_GRANT) {
    throw new ToolError(`${MAX_UNCONFIRMED_PER_GRANT} answers you recorded are waiting for the owner to confirm; ask them to look at their qbase inbox first.`);
  }
  if (!(await RateLimitService.fromEnv(env).checkLimit(`grant:${grant.id}`, RELAYS_PER_HOUR, 3600, 'relay'))) {
    throw new ToolError(`at most ${RELAYS_PER_HOUR} recorded answers an hour per key; try again later.`);
  }
  if (args.force !== true && !args.ask_id) {
    const near = await nearPublic(env, [{ question_id: args.question_id, stem: args.stem }]);
    if (near.length) throw reuseRefusal(near);
  }
  try {
    const rec = await recordRelay(env, ownerKey, grant, {
      question_id: args.question_id, ask_id: args.ask_id, position: args.position,
      stem: args.stem, type: args.type, options: args.options, scale: args.scale,
      answer: args.answer, reasoning: args.reasoning,
    });
    return {
      data: {
        ok: true, ...rec, tier: 'Secret', provenance: 'relayed',
        next: 'Saved Secret, marked as recorded by you until the owner confirms it in their qbase inbox. Tell the owner in a line what you saved.' +
          (waiting + 1 >= NUDGE_UNCONFIRMED ? ` ${waiting + 1} answers you recorded are unconfirmed: mention their qbase inbox once.` : ''),
      },
      served: [],
    };
  } catch (e) {
    if (e instanceof AskError) throw new ToolError(e.message);
    throw e;
  }
}

/** Below this (cosine, bge-base) a public question is too far from the query to be worth reusing. */
const FIND_MIN_SIMILARITY = 0.7;

async function findQuestions(env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args.query, 'query', 300)!;
  const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8) || 8));
  const vs = VectorService.fromEnv(env);
  const matches = (await vs.searchSimilar(await vs.vectorize(query), 'q', Math.min(50, limit * 3)))
    .filter((m) => m.score >= FIND_MIN_SIMILARITY);

  const ids = matches.map((m) => m.id);
  const { results } = ids.length
    ? await env.DB.prepare(
      `SELECT id, stem, type, a_options, scale_config, pub_answers, template, taxonomy FROM queries WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all()
    : { results: [] };
  const rows = new Map(((results ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
  // Whether the owner answered is about the owner: only keys that read answers, within their ceiling.
  // Within the key's ceiling and domains, like every other read: a fitness key doesn't learn the owner has a politics answer.
  let answered: Map<string, string> | null = null;
  if (grant.disclosure === 'raw') {
    const record = await loadOwnerRecord(env, ownerKey, grant);
    answered = new Map(record.answers
      .filter((a) => withinCeiling(a.audience, grant.ceiling) && inDomains(a.taxonomy, grant.domains))
      .map((a) => [a.q_id, a.audience]));
  }

  const questions = [];
  for (const m of matches) {
    const r = rows.get(m.id);
    if (!r || r.template || !['text', 'mc', 'checkbox', 'scale'].includes(String(r.type))) continue;
    let primary: string | undefined;
    try { primary = JSON.parse(String(r.taxonomy ?? '{}')).primary_type; } catch { /* unclassified */ }
    if (primary === 'invalid') continue;
    questions.push({
      question_id: m.id, stem: String(r.stem).trim(), type: r.type,
      ...(r.type === 'mc' || r.type === 'checkbox' ? { options: parseOptions(r.a_options as string | null) } : {}),
      public_answers: Number(r.pub_answers ?? 0),
      ...(primary === 'predictive' ? { prediction: true } : {}),
      ...(answered ? { owner_answered: answered.has(m.id) } : {}),
      similarity: Math.round(m.score * 1000) / 1000,
    });
    if (questions.length >= limit) break;
  }

  // The owner's own questions (agent-written, sealed), ranked inside Cloudflare like rankSealed: keys that read Secret only.
  let own: Array<Record<string, unknown>> = [];
  if (grant.disclosure === 'raw' && grant.ceiling === 'Secret') {
    const mine = [...(await loadOwnerQuestions(env, ownerKey)).values()]
      .filter((q) => inDomains(q.topics?.length ? { topics: q.topics } : null, grant.domains));
    if (mine.length) {
      const vecs = await embedAll(env, [query, ...mine.map((q) => embedText(q.stem, q.options))]);
      own = mine
        .map((q, i) => ({ q, score: cosine(vecs[0], vecs[i + 1]) }))
        .filter((x) => x.score >= FIND_MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ q, score }) => ({
          question_id: q.id, stem: q.stem, type: q.type, owner_only: true,
          ...(q.options ? { options: q.options } : {}), ...(q.scale ? { scale: q.scale } : {}),
          owner_answered: answered?.has(q.id) ?? false, similarity: Math.round(score * 1000) / 1000,
        }));
    }
  }
  // Whether the owner answered is itself something read: log the tier of each one disclosed.
  const served = answered
    ? [...questions, ...own].filter((q) => q.owner_answered).map((q) => answered!.get(String(q.question_id)) ?? 'Private')
    : [];
  return { data: { query, questions, ...(own.length ? { owner_only: own } : {}) }, served };
}

/** Per-request context: `origin` builds links back to qbase (ask_owner's answer link). */
export interface ToolCtx { origin: string }

const HANDLERS: Record<string, (env: Env, ownerKey: number, grant: Grant, args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>> = {
  get_context: getContext,
  search_my_positions: searchMyPositions,
  get_answer_history: getAnswerHistory,
  list_my_answers: listMyAnswersTool,
  get_profile: getProfile,
  ask_owner: askOwner,
  get_asked: getAsked,
  record_answer: recordAnswer,
  find_questions: findQuestions,
};

/** Run a tool and log the read. Throws ToolError for bad input / disclosure. */
export async function callTool(env: Env, ownerKey: number, grant: Grant, name: string, args: Record<string, unknown>, ctx: ToolCtx = { origin: 'https://qbase.tech' }): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`unknown tool: ${name}`);
  const { data, served } = await handler(env, ownerKey, grant, args ?? {}, ctx);
  await logRead(env, grant.id, name, served);
  return data;
}
