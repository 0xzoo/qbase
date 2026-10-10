/**
 * Asks: an agent asks its owner questions through the inbox (docs/specs/personal-mcp.md
 * §3.2–3.3, migration 0081). Agents never answer; they write asks, the owner
 * answers at /me/inbox.
 *
 * An ask carries the decision it serves, why the agent needs it, an optional
 * note with the specifics, and 1–7 items. An item is either a public question
 * (an existing `queries` id; answered through the normal answer path at the
 * tier the owner picks) or an owner-only question (`owner_questions`, sealed,
 * never on any public surface; its answers are Secret). A new stem an agent
 * writes becomes owner-only: an agent never adds to the public commons. Exact
 * repeats are reused, a public question first, then the owner's own.
 *
 * Everything about the owner is sealed (see 0081 for why the item list lives
 * inside the blob). The ask row's plaintext is its owner, the asking grant, a
 * status and when it was made.
 */

import { SecretStore } from '../secret/SecretStore';
import { parseOptions, parseScaleConfig } from '../SnapService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const MAX_ITEMS = 7;
export const MAX_PENDING_PER_GRANT = 5;
const MAX_STEM = 300;
const MAX_OPTION = 120;
const MAX_OPTIONS = 10;
const MAX_TEXT_ANSWER = 2000;
const MAX_REASONING = 2000;
export const ITEM_TYPES = ['text', 'mc', 'checkbox', 'scale'] as const;
export type ItemType = typeof ITEM_TYPES[number];
export type AskStatus = 'pending' | 'answered' | 'declined';

export class AskError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ScaleSpec {
  min: number;
  max: number;
  /** Endpoint or point labels by value, as `queries.scale_config` stores them: {"1": "never", "5": "always"}. */
  labels?: Record<string, string>;
}

export interface NewItem {
  stem: string;
  type: ItemType;
  options?: string[];
  scale?: ScaleSpec;
}

export type ItemInput = { question_id: string } | NewItem;

export interface ItemQuestion {
  id: string;
  owner_only: boolean;
  stem: string;
  type: ItemType;
  options: string[] | null;
  scale: ScaleSpec | null;
}

interface SealedItem { question_id: string; answered: boolean; skipped: boolean }
interface SealedAsk { decision: string; why_needed: string; note: string | null; items: SealedItem[] }
interface SealedOwnerQuestion { stem: string; options?: string[]; scale?: ScaleSpec }
export interface SealedOwnerAnswer { value: string; reasoning: string | null }

interface AskRow { id: string; owner_key: number; grant_id: string; status: AskStatus; sealed: string; created_at: number }

export const isOwnerQuestionId = (id: string) => id.startsWith('oq_');

const ctx = (table: string, id: string, owner: number) => SecretStore.ctxFor(`${table}:${id}`, 'Secret', owner);
const seal = (env: Env, table: string, id: string, owner: number, obj: unknown) => SecretStore.sealForD1(env, JSON.stringify(obj), ctx(table, id, owner));
const open = <T>(env: Env, table: string, id: string, owner: number, text: string) => SecretStore.openFromD1<T>(env, text, ctx(table, id, owner));

const normStem = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function text(v: unknown, name: string, max: number, required = true): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new AskError(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new AskError(`${name} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new AskError(`${name}: at most ${max} characters`);
  return s;
}

/** Validate an agent-written item. */
export function validateNewItem(raw: Record<string, unknown>): NewItem {
  const stem = text(raw.stem, 'item stem', MAX_STEM)!;
  const type = raw.type ?? 'text';
  if (!ITEM_TYPES.includes(type as ItemType)) throw new AskError(`item type must be one of ${ITEM_TYPES.join(', ')}`);
  const item: NewItem = { stem, type: type as ItemType };
  if (type === 'mc' || type === 'checkbox') {
    if (!Array.isArray(raw.options)) throw new AskError(`a ${type} item needs options`);
    const options = [...new Set(raw.options.map((o) => text(o, 'option', MAX_OPTION)!))];
    if (options.length < 2 || options.length > MAX_OPTIONS) throw new AskError(`a ${type} item needs 2–${MAX_OPTIONS} distinct options`);
    if (options.some((o) => o.includes(','))) throw new AskError('options cannot contain commas');
    item.options = options;
  }
  if (type === 'scale') {
    const s = (raw.scale ?? {}) as Record<string, unknown>;
    const min = Number(s.min ?? 1);
    const max = Number(s.max ?? 5);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max || max - min > 10) {
      throw new AskError('scale needs integer min < max, at most 10 apart');
    }
    item.scale = { min, max };
    if (s.labels && typeof s.labels === 'object') {
      const labels: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.labels as Record<string, unknown>)) {
        const n = Number(k);
        if (Number.isInteger(n) && n >= min && n <= max && typeof v === 'string' && v.trim()) labels[String(n)] = v.trim().slice(0, MAX_OPTION);
      }
      if (Object.keys(labels).length) item.scale.labels = labels;
    }
  }
  return item;
}

function scaleOf(a_options: string | null, scale_config: string | null): ScaleSpec | null {
  const c = parseScaleConfig(a_options) ?? parseScaleConfig(scale_config);
  return c ? { min: c.min, max: c.max, ...(c.labels ? { labels: c.labels as Record<string, string> } : {}) } : null;
}

async function publicQuestion(env: Env, id: string): Promise<ItemQuestion | null> {
  const q = await env.DB.prepare('SELECT id, stem, type, a_options, scale_config FROM queries WHERE id = ?').bind(id).first() as
    { id: string; stem: string; type: string; a_options: string | null; scale_config: string | null } | null;
  if (!q || !ITEM_TYPES.includes(q.type as ItemType)) return null;
  const type = q.type as ItemType;
  return {
    id: q.id, owner_only: false, stem: q.stem, type,
    options: type === 'mc' || type === 'checkbox' ? parseOptions(q.a_options) : null,
    scale: type === 'scale' ? scaleOf(q.a_options, q.scale_config) : null,
  };
}

/** The owner's owner-only questions, opened. Small per owner; opened in full only on the paths that need it. */
export async function loadOwnerQuestions(env: Env, ownerKey: number, ids?: string[]): Promise<Map<string, ItemQuestion & { created_at: number }>> {
  const filter = ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
  if (ids && ids.length === 0) return new Map();
  const { results } = await env.DB.prepare(`SELECT id, type, sealed, created_at FROM owner_questions WHERE owner_key = ?${filter}`)
    .bind(ownerKey, ...(ids ?? [])).all();
  const out = new Map<string, ItemQuestion & { created_at: number }>();
  for (const r of (results ?? []) as Array<{ id: string; type: ItemType; sealed: string; created_at: number }>) {
    const s = await open<SealedOwnerQuestion>(env, 'owner_questions', r.id, ownerKey, r.sealed);
    out.set(r.id, { id: r.id, owner_only: true, stem: s.stem, type: r.type, options: s.options ?? null, scale: s.scale ?? null, created_at: r.created_at });
  }
  return out;
}

/** Item questions by id, public and owner-only. Missing ids are left out. */
export async function resolveQuestions(env: Env, ownerKey: number, ids: string[]): Promise<Map<string, ItemQuestion>> {
  const out = new Map<string, ItemQuestion>(await loadOwnerQuestions(env, ownerKey, ids.filter(isOwnerQuestionId)));
  for (const id of ids.filter((i) => !isOwnerQuestionId(i))) {
    const q = await publicQuestion(env, id);
    if (q) out.set(id, q);
  }
  return out;
}

export interface CreateAskInput {
  decision: unknown;
  why_needed: unknown;
  note?: unknown;
  items: unknown;
}

export interface CreatedAsk {
  ask_id: string;
  items: Array<{ position: number; question_id: string; owner_only: boolean; stem: string; reused: boolean }>;
}

/**
 * `ownerOnly`: whether the asking key can read Secret. Owner-only questions are always answered
 * Secret, so a key below that could never read the answer and may not ask one. The pending cap
 * (MAX_PENDING_PER_GRANT) is the caller's: it has to count what the key can see (tools.ts).
 */
export async function createAsk(env: Env, ownerKey: number, grantId: string, input: CreateAskInput, opts: { ownerOnly: boolean }): Promise<CreatedAsk> {
  const decision = text(input.decision, 'decision', 500)!;
  const why_needed = text(input.why_needed, 'why_needed', 500)!;
  const note = text(input.note, 'note', 1000, false);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) {
    throw new AskError(`items: 1–${MAX_ITEMS} questions`);
  }

  const askId = crypto.randomUUID();
  const now = Date.now();
  const statements: unknown[] = [];
  const out: CreatedAsk['items'] = [];
  let ownQuestions: Map<string, ItemQuestion> | null = null;

  for (const raw of input.items as unknown[]) {
    if (!raw || typeof raw !== 'object') throw new AskError('each item is {question_id} or {stem, type, options?, scale?}');
    const r = raw as Record<string, unknown>;
    let q: ItemQuestion | null = null;
    let reused = false;

    if (typeof r.question_id === 'string' && r.question_id) {
      q = isOwnerQuestionId(r.question_id)
        ? (await loadOwnerQuestions(env, ownerKey, [r.question_id])).get(r.question_id) ?? null
        : await publicQuestion(env, r.question_id);
      if (!q) throw new AskError(`no askable question ${r.question_id} (text, mc, checkbox or scale)`);
      reused = true;
    } else {
      const item = validateNewItem(r);
      // Reuse an exact repeat: a public question first, so the answer can count; then the owner's own.
      const pub = await env.DB.prepare('SELECT id FROM queries WHERE lower(trim(stem)) = ? AND type = ? LIMIT 1')
        .bind(normStem(item.stem), item.type).first() as { id: string } | null;
      if (pub) q = await publicQuestion(env, pub.id);
      if (!q) {
        ownQuestions ??= await loadOwnerQuestions(env, ownerKey);
        q = [...ownQuestions.values()].find((o) => o.type === item.type && normStem(o.stem) === normStem(item.stem)) ?? null;
      }
      if (q) {
        reused = true;
      } else {
        const id = `oq_${crypto.randomUUID()}`;
        const sealed: SealedOwnerQuestion = { stem: item.stem, ...(item.options ? { options: item.options } : {}), ...(item.scale ? { scale: item.scale } : {}) };
        statements.push(env.DB.prepare('INSERT INTO owner_questions (id, owner_key, type, sealed, ask_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, ownerKey, item.type, await seal(env, 'owner_questions', id, ownerKey, sealed), askId, now));
        q = { id, owner_only: true, stem: item.stem, type: item.type, options: item.options ?? null, scale: item.scale ?? null };
        ownQuestions?.set(id, q);
      }
    }
    if (q.owner_only && !opts.ownerOnly) {
      throw new AskError('this key can\'t read Secret answers, and a question only the owner sees is always answered Secret; ' +
        'ask an existing public question by question_id instead');
    }
    if (out.some((o) => o.question_id === q!.id)) continue;
    out.push({ position: out.length, question_id: q.id, owner_only: q.owner_only, stem: q.stem, reused });
  }

  const sealed: SealedAsk = { decision, why_needed, note, items: out.map((o) => ({ question_id: o.question_id, answered: false, skipped: false })) };
  statements.push(env.DB.prepare("INSERT INTO asks (id, owner_key, grant_id, status, sealed, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
    .bind(askId, ownerKey, grantId, await seal(env, 'asks', askId, ownerKey, sealed), now));
  await env.DB.batch(statements);
  return { ask_id: askId, items: out };
}

export interface OpenedAsk {
  id: string;
  grant_id: string;
  status: AskStatus;
  created_at: number;
  decision: string;
  why_needed: string;
  note: string | null;
  items: SealedItem[];
  /** The stored blob this was opened from: markItem writes only if it's unchanged. */
  sealed: string;
}

async function openAsk(env: Env, row: AskRow): Promise<OpenedAsk> {
  const s = await open<SealedAsk>(env, 'asks', row.id, Number(row.owner_key), row.sealed);
  return { id: row.id, grant_id: row.grant_id, status: row.status, created_at: Number(row.created_at), ...s, sealed: row.sealed };
}

export async function listAsks(
  env: Env,
  where: { ownerKey: number; grantId?: string; status?: AskStatus | 'all' },
  limit = 50,
): Promise<OpenedAsk[]> {
  const clauses = ['owner_key = ?'];
  const binds: unknown[] = [where.ownerKey];
  if (where.grantId) { clauses.push('grant_id = ?'); binds.push(where.grantId); }
  if (where.status && where.status !== 'all') { clauses.push('status = ?'); binds.push(where.status); }
  const { results } = await env.DB.prepare(`SELECT * FROM asks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit).all();
  return Promise.all(((results ?? []) as AskRow[]).map((r) => openAsk(env, r)));
}

export async function getAsk(env: Env, ownerKey: number, askId: string): Promise<OpenedAsk> {
  const row = await env.DB.prepare('SELECT * FROM asks WHERE id = ? AND owner_key = ?').bind(askId, ownerKey).first() as AskRow | null;
  if (!row) throw new AskError('no such ask', 404);
  return openAsk(env, row);
}

/**
 * Record an item answered or skipped; the ask is answered once every item is one or the other.
 * Compare-and-set on the stored blob and status, so two items saved at once (or a decline in
 * between) don't overwrite each other: on a lost race it re-reads and applies the mark again.
 */
export async function markItem(env: Env, ownerKey: number, ask: OpenedAsk, position: number, mark: 'answered' | 'skipped'): Promise<OpenedAsk> {
  let current = ask;
  for (let attempt = 0; attempt < 4; attempt++) {
    const items = current.items.map((it, i) => (i === position
      ? { ...it, answered: it.answered || mark === 'answered', skipped: mark === 'skipped' && !it.answered }
      : it));
    const done = items.every((it) => it.answered || it.skipped);
    const status: AskStatus = current.status === 'declined' ? 'declined' : done ? 'answered' : 'pending';
    const next: SealedAsk = { decision: current.decision, why_needed: current.why_needed, note: current.note, items };
    const blob = await seal(env, 'asks', current.id, ownerKey, next);
    const r = await env.DB.prepare('UPDATE asks SET sealed = ?, status = ? WHERE id = ? AND owner_key = ? AND sealed = ? AND status = ?')
      .bind(blob, status, current.id, ownerKey, current.sealed, current.status).run();
    if (r.meta?.changes) return { ...current, items, status, sealed: blob };
    current = await getAsk(env, ownerKey, current.id);
  }
  throw new AskError('the ask changed while saving; try again', 409);
}

export async function declineAsk(env: Env, ownerKey: number, askId: string): Promise<void> {
  const r = await env.DB.prepare("UPDATE asks SET status = 'declined' WHERE id = ? AND owner_key = ?").bind(askId, ownerKey).run();
  if (!r.meta?.changes) throw new AskError('no such ask', 404);
}

/**
 * A choice, choices, number or text, checked against the question and put in
 * the shape `Answers` stores (value string + answer_type_id + answer_data).
 */
export function normaliseAnswer(q: ItemQuestion, raw: unknown): { value: string; answer_type_id: number; answer_data?: Record<string, unknown> } {
  switch (q.type) {
    case 'text': {
      const v = text(raw, 'answer', MAX_TEXT_ANSWER)!;
      return { value: v, answer_type_id: 1 };
    }
    case 'mc': {
      const index = (q.options ?? []).indexOf(String(raw));
      if (typeof raw !== 'string' || index < 0) throw new AskError('pick one of the options');
      return { value: raw, answer_type_id: 2, answer_data: { index } };
    }
    case 'checkbox': {
      if (!Array.isArray(raw) || raw.length === 0) throw new AskError('pick at least one option');
      const opts = q.options ?? [];
      const picked = opts.filter((o) => raw.includes(o));
      if (picked.length !== new Set(raw).size) throw new AskError('pick only from the options');
      return { value: picked.join(', '), answer_type_id: 4, answer_data: { indices: picked.map((p) => opts.indexOf(p)) } };
    }
    case 'scale': {
      const n = Number(raw);
      const min = q.scale?.min ?? 1;
      const max = q.scale?.max ?? 5;
      if (!Number.isInteger(n) || n < min || n > max) throw new AskError(`a whole number from ${min} to ${max}`);
      return { value: String(n), answer_type_id: 3, answer_data: { index: n } };
    }
  }
}

export function validReasoning(raw: unknown): string | null {
  return text(raw, 'reasoning', MAX_REASONING, false);
}

/** Append an answer to an owner-only question (always Secret). */
export async function answerOwnerQuestion(
  env: Env, ownerKey: number, questionId: string, value: string, reasoning: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO owner_answers (id, owner_question_id, owner_key, sealed, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, questionId, ownerKey, await seal(env, 'owner_answers', id, ownerKey, { value, reasoning } satisfies SealedOwnerAnswer), new Date().toISOString())
    .run();
  return id;
}

export interface OwnerAnswerRow { id: string; owner_question_id: string; sealed: string; created_at: string }

export async function listOwnerAnswerRows(env: Env, ownerKey: number): Promise<OwnerAnswerRow[]> {
  const { results } = await env.DB.prepare('SELECT id, owner_question_id, sealed, created_at FROM owner_answers WHERE owner_key = ?').bind(ownerKey).all();
  return (results ?? []) as OwnerAnswerRow[];
}

export function openOwnerAnswer(env: Env, ownerKey: number, row: Pick<OwnerAnswerRow, 'id' | 'sealed'>): Promise<SealedOwnerAnswer> {
  return open<SealedOwnerAnswer>(env, 'owner_answers', row.id, ownerKey, row.sealed);
}
