/**
 * Relayed answers (docs/specs/personal-mcp.md §3.3, migration 0082):
 * an agent in a conversation with the owner records the owner's answer, in
 * the owner's words, with record_answer. Rules the code carries:
 *
 *  - Secret only. A public question gets an `Answers` row at `Private`, an
 *    owner-only one an `owner_answers` row. Never Anon or Public from a key.
 *  - Marked. A `relays` row says which key wrote it; every agent reads it as
 *    provenance 'relayed' until the owner confirms.
 *  - Confirm drops the mark, whatever the tier: the row is deleted, nothing
 *    of it kept. Confirming as Anon writes a fresh Anon answer and deletes the
 *    relayed row, so the Anon row's time isn't the write's time. grant_reads
 *    logs record_answer only to the day, for a relay confirmed Secret and
 *    moved to Anon later from elsewhere (its created_at stays).
 *  - Deleting a relay that answered an ask item puts the item back to pending.
 *
 * The answer row and its mark are written in one batch, so a relayed answer
 * never exists unmarked.
 */

import { SecretStore } from '../secret/SecretStore';
import { inDomains, type Grant } from './context';
import {
  AskError, getAsk, markItem, normaliseAnswer, openOwnerAnswer, ownerAnswerRewrite, ownerAnswerStatement,
  resolveItem, resolveQuestions, validReasoning, type ItemQuestion,
} from './AskService';
import { farcasterFidOf } from '../accounts/AccountService';
import { sealedAnswerKey, openSealedAnswer, storageKeyOf } from '../../handlers/answers/shared';
import { applyAnswerUpdate, type ExistingAnswerRow } from '../../handlers/answers/mutate';
import { handleCreateAnswer } from '../../handlers/answers/create';
import { resolveStickyAudience } from '../AudienceService';
import { anonTagReady } from '../anon/AnonTag';
import { authorTags } from '../AnonAttributionService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Unconfirmed relays one key may have waiting: an abuse bound, not a workflow step. The mark carries
 * the safety, so an owner who never opens the inbox loses nothing; past NUDGE_UNCONFIRMED the tool
 * asks the agent to mention the inbox.
 */
export const MAX_UNCONFIRMED_PER_GRANT = 500;
export const NUDGE_UNCONFIRMED = 25;
/** Relays per key per hour (on top of /mcp's per-key call limit). */
export const RELAYS_PER_HOUR = 30;

export type RelayKind = 'answer' | 'owner_answer';

interface RelayRow {
  answer_id: string;
  kind: RelayKind;
  owner_key: number;
  grant_id: string;
  ask_id: string | null;
  ask_position: number | null;
  created_at: number;
}

const relayInsert = (env: Env, r: RelayRow) => env.DB.prepare(
  'INSERT INTO relays (answer_id, kind, owner_key, grant_id, ask_id, ask_position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
).bind(r.answer_id, r.kind, r.owner_key, r.grant_id, r.ask_id, r.ask_position, r.created_at);

/** The statement clearing a relay mark, for batches that change the answer row (applyAnswerUpdate, delete). */
export const relayDelete = (env: Env, answerId: string) => env.DB.prepare('DELETE FROM relays WHERE answer_id = ?').bind(answerId);

export async function isRelayed(env: Env, answerId: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 AS x FROM relays WHERE answer_id = ?').bind(answerId).first());
}

/** Ids of the owner's unconfirmed relayed answers (both kinds). */
export async function relayedIds(env: Env, ownerKey: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare('SELECT answer_id FROM relays WHERE owner_key = ?').bind(ownerKey).all();
  return new Set(((results ?? []) as Array<{ answer_id: string }>).map((r) => r.answer_id));
}

export async function countUnconfirmed(env: Env, where: { ownerKey: number; grantId?: string }): Promise<number> {
  const row = where.grantId
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM relays WHERE owner_key = ? AND grant_id = ?').bind(where.ownerKey, where.grantId).first()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM relays WHERE owner_key = ?').bind(where.ownerKey).first();
  return Number((row as { n: number } | null)?.n ?? 0);
}

export interface RecordInput {
  question_id?: unknown;
  ask_id?: unknown;
  position?: unknown;
  stem?: unknown;
  type?: unknown;
  options?: unknown;
  scale?: unknown;
  answer: unknown;
  reasoning?: unknown;
}

export interface Recorded {
  answer_id: string;
  question_id: string;
  owner_only: boolean;
  stem: string;
  reused: boolean;
  /** Set when the relay answered an ask item. */
  ask_id?: string;
}

/**
 * Write one relayed answer. Ceiling, disclosure, rate and the unconfirmed cap are the caller's
 * (tools.ts), since they're about the key; this checks the question and the answer.
 */
export async function recordRelay(env: Env, ownerKey: number, grant: Grant, input: RecordInput): Promise<Recorded> {
  const now = Date.now();
  let askRef: { ask: Awaited<ReturnType<typeof getAsk>>; position: number } | null = null;
  let q: ItemQuestion;
  let reused = true;
  let insertQuestion: unknown;

  if (typeof input.ask_id === 'string' && input.ask_id) {
    const ask = await getAsk(env, ownerKey, input.ask_id);
    if (ask.grant_id !== grant.id) throw new AskError('no such ask', 404);
    if (ask.status === 'declined') throw new AskError('the owner declined this ask');
    const position = Number(input.position);
    const item = Number.isInteger(position) ? ask.items[position] : undefined;
    if (!item) throw new AskError('position: the item\'s index in the ask (0-based)');
    if (item.answered || item.skipped) throw new AskError(`that item is already ${item.answered ? 'answered' : 'skipped'}`, 409);
    // A relay already written for it (and an item mark that didn't land) counts as answered: no second copy.
    if (await env.DB.prepare('SELECT 1 AS x FROM relays WHERE ask_id = ? AND ask_position = ?').bind(ask.id, position).first()) {
      throw new AskError('you already recorded an answer for that item', 409);
    }
    const found = (await resolveQuestions(env, ownerKey, [item.question_id])).get(item.question_id);
    if (!found) throw new AskError('the question is gone', 410);
    q = found;
    askRef = { ask, position };
  } else {
    const raw = typeof input.question_id === 'string' && input.question_id
      ? { question_id: input.question_id }
      : { stem: input.stem, type: input.type, options: input.options, scale: input.scale };
    const resolved = await resolveItem(env, ownerKey, raw, {
      topics: grant.domains === '*' ? undefined : grant.domains, askId: null, now, cache: { own: null },
    });
    q = resolved.q;
    reused = resolved.reused;
    insertQuestion = resolved.insert;
  }

  // A key scoped to topics writes only within them (a new owner-only question carries its domains).
  let primaryType = 'recurring';
  if (!q.owner_only) {
    const row = await env.DB.prepare('SELECT taxonomy FROM queries WHERE id = ?').bind(q.id).first() as { taxonomy: string | null } | null;
    let taxonomy: { primary_type?: string; topics?: string[] } | null = null;
    try { taxonomy = row?.taxonomy ? JSON.parse(row.taxonomy) : null; } catch { /* unclassified */ }
    if (taxonomy?.primary_type === 'predictive') {
      throw new AskError('a prediction is the owner\'s to make and can\'t be edited later; ask it with ask_owner instead');
    }
    if (!inDomains(taxonomy?.topics ? { topics: taxonomy.topics } : null, grant.domains)) throw new AskError('this question is outside the topics this key covers');
    primaryType = taxonomy?.primary_type ?? 'recurring';
  } else if (!insertQuestion && !inDomains(q.topics?.length ? { topics: q.topics } : null, grant.domains)) {
    throw new AskError('this question is outside the topics this key covers');
  }

  const answer = normaliseAnswer(q, input.answer);
  const reasoning = validReasoning(input.reasoning);
  const answerId = crypto.randomUUID();
  const mark = (kind: RelayKind) => relayInsert(env, {
    answer_id: answerId, kind, owner_key: ownerKey, grant_id: grant.id,
    ask_id: askRef?.ask.id ?? null, ask_position: askRef?.position ?? null, created_at: now,
  });

  if (q.owner_only) {
    const { statement } = await ownerAnswerStatement(env, ownerKey, q.id, answer.value, reasoning, answerId);
    await env.DB.batch([...(insertQuestion ? [insertQuestion] : []), statement, mark('owner_answer')]);
  } else {
    const storageKey = sealedAnswerKey('Private', answerId);
    await SecretStore.putJSON(env, storageKey, { value: answer.value, answer_data: answer.answer_data ?? null, reasoning }, {
      tier: 'Private',
      owner: ownerKey,
      meta: { 'q-id': q.id, 'user-id': String(ownerKey), audience: 'Private', 'answer-type-id': String(answer.answer_type_id) },
    });
    const ref = `qstorage:${storageKey}`;
    const responderFid = (await farcasterFidOf(env, ownerKey)) ?? null;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, storage_ref, poll_id)
           VALUES (?, ?, ?, '[encrypted]', ?, NULL, 'Private', ?, ?, ?, NULL)`,
        ).bind(answerId, q.id, ownerKey, String(answer.answer_type_id), new Date(now).toISOString(), primaryType, ref),
        env.DB.prepare(
          `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
           VALUES (?, ?, NULL, NULL, ?, 'private', ?, NULL, NULL, 0, ?)`,
        ).bind(answerId, q.id, responderFid, ref, now),
        env.DB.prepare('UPDATE queries SET priv_answers = priv_answers + 1 WHERE id = ?').bind(q.id),
        mark('answer'),
      ]);
    } catch (e) {
      await SecretStore.deleteObject(env, storageKey).catch(() => {});
      throw e;
    }
  }

  if (askRef) await markItem(env, ownerKey, askRef.ask, askRef.position, 'answered');
  return {
    answer_id: answerId, question_id: q.id, owner_only: q.owner_only, stem: q.stem, reused,
    ...(askRef ? { ask_id: askRef.ask.id } : {}),
  };
}

export interface OpenedRelay {
  answer_id: string;
  kind: RelayKind;
  grant_id: string;
  created_at: number;
  ask_id: string | null;
  question: ItemQuestion | null;
  /** The answer as stored: a choice, choices joined with ", ", a number as a string, or text. */
  answer: string | null;
  reasoning: string | null;
}

/** The owner's unconfirmed relays, opened, newest first. */
export async function listRelays(env: Env, ownerKey: number): Promise<OpenedRelay[]> {
  const rows = ((await env.DB.prepare('SELECT * FROM relays WHERE owner_key = ? ORDER BY created_at DESC').bind(ownerKey).all())
    .results ?? []) as RelayRow[];
  if (rows.length === 0) return [];

  const answers = new Map<string, ExistingAnswerRow>();
  const ownerAnswers = new Map<string, { id: string; owner_question_id: string; sealed: string }>();
  const ids = (kind: RelayKind) => rows.filter((r) => r.kind === kind).map((r) => r.answer_id);
  for (const [kind, sql] of [
    ['answer', 'SELECT * FROM Answers WHERE user_id = ? AND id IN'],
    ['owner_answer', 'SELECT id, owner_question_id, sealed FROM owner_answers WHERE owner_key = ? AND id IN'],
  ] as const) {
    const list = ids(kind);
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const { results } = await env.DB.prepare(`${sql} (${chunk.map(() => '?').join(',')})`).bind(ownerKey, ...chunk).all();
      for (const r of (results ?? []) as Array<Record<string, unknown>>) {
        if (kind === 'answer') answers.set(String(r.id), r as ExistingAnswerRow);
        else ownerAnswers.set(String(r.id), r as { id: string; owner_question_id: string; sealed: string });
      }
    }
  }
  const qIds = [...new Set([...[...answers.values()].map((a) => a.q_id), ...[...ownerAnswers.values()].map((a) => a.owner_question_id)])];
  const questions = await resolveQuestions(env, ownerKey, qIds);

  const out: OpenedRelay[] = [];
  for (const r of rows) {
    const base = { answer_id: r.answer_id, kind: r.kind, grant_id: r.grant_id, created_at: Number(r.created_at), ask_id: r.ask_id };
    let payload: { value?: unknown; reasoning?: unknown } | null = null;
    let qid: string | null = null;
    try {
      if (r.kind === 'answer') {
        const a = answers.get(r.answer_id);
        if (!a) continue; // the row went some other way; the mark is stale
        qid = a.q_id;
        payload = await openSealedAnswer(env, a);
      } else {
        const a = ownerAnswers.get(r.answer_id);
        if (!a) continue;
        qid = a.owner_question_id;
        payload = await openOwnerAnswer(env, ownerKey, a);
      }
    } catch (e) {
      console.warn(`[relays] could not open ${r.answer_id}:`, e instanceof Error ? e.message : e);
    }
    out.push({
      ...base,
      question: qid ? questions.get(qid) ?? null : null,
      answer: payload?.value === undefined || payload?.value === null ? null : String(payload.value),
      reasoning: typeof payload?.reasoning === 'string' && payload.reasoning ? payload.reasoning : null,
    });
  }
  return out;
}

/**
 * Delete a relayed Private row with its mark, in one batch; then its sealed object. A relayed row
 * never had a vector, a cast or likes (it was only ever Secret), so there's nothing else to clear.
 */
async function deleteRelayedRow(env: Env, ownerKey: number, answerId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT q_id, storage_ref FROM Answers WHERE id = ? AND user_id = ? AND audience = \'Private\'')
    .bind(answerId, ownerKey).first() as { q_id: string; storage_ref: string | null } | null;
  if (!row) {
    await relayDelete(env, answerId).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM Answers WHERE id = ?').bind(answerId),
    env.DB.prepare('DELETE FROM answer_meta WHERE id = ?').bind(answerId),
    env.DB.prepare('UPDATE queries SET priv_answers = MAX(0, priv_answers - 1) WHERE id = ?').bind(row.q_id),
    relayDelete(env, answerId),
  ]);
  const key = storageKeyOf(row.storage_ref);
  if (key) await SecretStore.deleteObject(env, key).catch((e: unknown) => console.error(`[relays] could not delete ${key}:`, e));
}

async function relayRow(env: Env, ownerKey: number, answerId: string): Promise<RelayRow> {
  const r = await env.DB.prepare('SELECT * FROM relays WHERE answer_id = ? AND owner_key = ?').bind(answerId, ownerKey).first() as RelayRow | null;
  if (!r) throw new AskError('no such unconfirmed answer (already confirmed or deleted?)', 404);
  return r;
}

export interface ConfirmInput {
  /** An edit, in the question's shape (as record_answer takes it). Omitted: confirm as recorded. */
  answer?: unknown;
  reasoning?: unknown;
  /** Secret (default), Anon or Public. Owner-only questions are always Secret. */
  audience?: unknown;
}

const TIERS: Record<string, 'Private' | 'Anon' | 'Public'> = { Secret: 'Private', Anon: 'Anon', Public: 'Public' };

/**
 * The owner confirms a relayed answer, optionally edited and moved to another tier. Afterwards
 * it is a plain stated answer: the mark is gone. Returns the tier it ended at (sticky audiences
 * can keep an earlier Anon/Public choice) and its row id (new when it moved to Anon).
 */
export async function confirmRelay(
  env: Env, ownerKey: number, answerId: string, input: ConfirmInput, origin: string,
): Promise<{ audience: 'Secret' | 'Anon' | 'Public'; answer_id: string }> {
  const relay = await relayRow(env, ownerKey, answerId);
  const to = TIERS[String(input.audience ?? 'Secret')];
  if (!to) throw new AskError('audience must be Secret, Anon or Public');
  const edited = input.answer !== undefined || input.reasoning !== undefined;

  if (relay.kind === 'owner_answer') {
    if (to !== 'Private') throw new AskError('only you see this question, so its answers stay Secret');
    if (!edited) {
      await relayDelete(env, answerId).run();
    } else {
      const row = await env.DB.prepare('SELECT id, owner_question_id, sealed FROM owner_answers WHERE id = ? AND owner_key = ?')
        .bind(answerId, ownerKey).first() as { id: string; owner_question_id: string; sealed: string } | null;
      if (!row) throw new AskError('the answer is gone', 410);
      const q = (await resolveQuestions(env, ownerKey, [row.owner_question_id])).get(row.owner_question_id);
      if (!q) throw new AskError('the question is gone', 410);
      const prior = await openOwnerAnswer(env, ownerKey, row);
      const value = input.answer !== undefined ? normaliseAnswer(q, input.answer).value : prior.value;
      const reasoning = input.reasoning !== undefined ? validReasoning(input.reasoning) : prior.reasoning;
      await env.DB.batch([await ownerAnswerRewrite(env, ownerKey, answerId, value, reasoning), relayDelete(env, answerId)]);
    }
    return { audience: 'Secret', answer_id: answerId };
  }

  const existing = await env.DB.prepare('SELECT * FROM Answers WHERE id = ? AND user_id = ?').bind(answerId, ownerKey).first() as ExistingAnswerRow | null;
  if (!existing) throw new AskError('the answer is gone', 410);
  if (to === 'Private' && !edited) {
    await relayDelete(env, answerId).run();
    return { audience: 'Secret', answer_id: answerId };
  }

  const q = (await resolveQuestions(env, ownerKey, [existing.q_id])).get(existing.q_id);
  if (!q) throw new AskError('the question is gone', 410);
  const prior = await openSealedAnswer(env, existing);
  const next = input.answer !== undefined
    ? normaliseAnswer(q, input.answer)
    : { value: String(prior?.value ?? ''), answer_type_id: Number(existing.answer_type_id), answer_data: (prior?.answer_data ?? undefined) as Record<string, unknown> | undefined };
  const reasoning = input.reasoning !== undefined ? validReasoning(input.reasoning) : ((prior?.reasoning as string | null | undefined) ?? null);
  if (!next.value) throw new AskError('the recorded answer would not open; edit it or delete it', 409);

  if (to === 'Anon') {
    // An earlier Public answer on the question keeps it Public (sticky audience): refuse rather than
    // let the create path quietly publish this one under the owner's name.
    const tags = (await anonTagReady(env)) ? await authorTags(env, ownerKey, existing.q_id) : null;
    const sticky = await resolveStickyAudience(env.DB, existing.q_id, ownerKey, null, 'Anon', tags);
    if (sticky.sticky && sticky.audience !== 'Anon') {
      throw new AskError('you answered this question publicly before, so a new answer here is public too; confirm it as Secret or Public', 409);
    }
    // A fresh row at the time of the confirm, then the relayed row goes (see the header).
    const res = await handleCreateAnswer(new Request(new URL('/api/answers', origin).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q_id: existing.q_id, value: next.value, answer_type_id: next.answer_type_id,
        ...(next.answer_data ? { answer_data: next.answer_data } : {}), ...(reasoning ? { reasoning } : {}),
        audience: 'Anon', user_id: ownerKey,
      }),
    }), env);
    if (!res.ok) {
      const text = await res.text();
      let error = text;
      try { error = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      throw new AskError(error || 'could not save the answer', res.status);
    }
    const saved = await res.json() as { answerId: string; audience?: string };
    try {
      await deleteRelayedRow(env, ownerKey, answerId);
    } catch (e) {
      console.error(`[relays] ${answerId} saved as Anon (${saved.answerId}) but the recorded copy stayed:`, e);
      throw new AskError('saved as Anon, but the recorded copy could not be removed: delete it instead of confirming again', 500);
    }
    return { audience: saved.audience === 'Public' ? 'Public' : 'Anon', answer_id: saved.answerId };
  }

  // Secret with edits, or Public: in place (applyAnswerUpdate clears the mark in its batch).
  const result = await applyAnswerUpdate(env, existing, {
    value: next.value, answer_type_id: next.answer_type_id, answer_data: next.answer_data ?? null, reasoning, audience: to,
  }, { actorFid: ownerKey });
  return { audience: result.audience === 'Private' ? 'Secret' : result.audience === 'Anon' ? 'Anon' : 'Public', answer_id: answerId };
}

/** Delete a relayed answer outright; an ask item it answered goes back to pending. */
/** How long the agent that recorded an answer is told the owner deleted it. */
const WITHDRAWN_TTL_S = 30 * 86400;
const withdrawnPrefix = (grantId: string) => `relay-withdrawn:${grantId}:`;

/**
 * The owner deleted an answer this key recorded: the key is told, so its agent drops it from its own notes
 * instead of quoting it again. Ids and the day only, never the answer (deleting it is the owner saying "don't keep this").
 */
export interface Withdrawn { answer_id: string; question_id: string; ask_id?: string; position?: number; withdrawn_on: string }

export async function noteWithdrawn(env: Env, relay: Pick<RelayRow, 'answer_id' | 'grant_id' | 'ask_id' | 'ask_position'>, questionId: string): Promise<void> {
  const meta: Withdrawn = {
    answer_id: relay.answer_id, question_id: questionId, withdrawn_on: new Date().toISOString().slice(0, 10),
    ...(relay.ask_id && relay.ask_position !== null ? { ask_id: relay.ask_id, position: Number(relay.ask_position) } : {}),
  };
  try {
    await env.KV_USER_PROFILES.put(withdrawnPrefix(relay.grant_id) + relay.answer_id, '', { expirationTtl: WITHDRAWN_TTL_S, metadata: meta });
  } catch (e) {
    console.warn('[relays] withdrawal note failed:', e instanceof Error ? e.message : e);
  }
}

export async function listWithdrawn(env: Env, grantId: string): Promise<Withdrawn[]> {
  try {
    const { keys } = await env.KV_USER_PROFILES.list({ prefix: withdrawnPrefix(grantId), limit: 100 });
    return keys.map((k: { metadata?: unknown }) => k.metadata as Withdrawn).filter((m: Withdrawn | undefined) => !!m?.answer_id);
  } catch {
    return [];
  }
}

/** Deletes a relayed answer. `notify`: tell the recording key (not on revocation: that key reads nothing any more). */
export async function deleteRelay(env: Env, ownerKey: number, answerId: string, { notify = true } = {}): Promise<void> {
  const relay = await relayRow(env, ownerKey, answerId);
  const questionId = notify ? await relayQuestionId(env, ownerKey, relay) : null;
  if (relay.kind === 'answer') {
    await deleteRelayedRow(env, ownerKey, answerId);
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM owner_answers WHERE id = ? AND owner_key = ?').bind(answerId, ownerKey),
      relayDelete(env, answerId),
    ]);
  }
  if (relay.ask_id && relay.ask_position !== null) {
    try {
      const ask = await getAsk(env, ownerKey, relay.ask_id);
      await markItem(env, ownerKey, ask, Number(relay.ask_position), 'pending');
    } catch (e) {
      if (!(e instanceof AskError && e.status === 404)) throw e;
    }
  }
  if (questionId) await noteWithdrawn(env, relay, questionId);
}

async function relayQuestionId(env: Env, ownerKey: number, relay: RelayRow): Promise<string | null> {
  const row = relay.kind === 'answer'
    ? await env.DB.prepare('SELECT q_id AS q FROM Answers WHERE id = ? AND user_id = ?').bind(relay.answer_id, ownerKey).first()
    : await env.DB.prepare('SELECT owner_question_id AS q FROM owner_answers WHERE id = ? AND owner_key = ?').bind(relay.answer_id, ownerKey).first();
  return row ? String((row as { q: string }).q) : null;
}

/** Confirm every unconfirmed relay as recorded (Secret, unedited); one that won't open stays for the owner to fix or delete. */
export async function confirmAll(env: Env, ownerKey: number): Promise<number> {
  const ok = (await listRelays(env, ownerKey)).filter((r) => r.answer !== null).map((r) => r.answer_id);
  for (let i = 0; i < ok.length; i += 90) {
    const chunk = ok.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM relays WHERE owner_key = ? AND answer_id IN (${chunk.map(() => '?').join(',')})`).bind(ownerKey, ...chunk).run();
  }
  return ok.length;
}

/** Revocation: delete a key's unconfirmed relays. */
export async function deleteGrantRelays(env: Env, ownerKey: number, grantId: string): Promise<number> {
  const { results } = await env.DB.prepare('SELECT answer_id FROM relays WHERE owner_key = ? AND grant_id = ?').bind(ownerKey, grantId).all();
  const ids = ((results ?? []) as Array<{ answer_id: string }>).map((r) => r.answer_id);
  for (const id of ids) await deleteRelay(env, ownerKey, id, { notify: false });
  return ids.length;
}
