/**
 * When the owner deletes an answer an agent recorded (record_answer, RelayService), the ask item it answered
 * reopens and the key that recorded it is told, so its agent drops the answer from its own notes instead of
 * quoting it again. The note carries ids and the day only, never the answer: deleting it is the owner saying
 * "don't keep this". Kept apart from RelayService so the answer handlers can use it without importing it.
 */

import { AskError, getAsk, markItem } from './AskService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/** How long the key is told. */
const WITHDRAWN_TTL_S = 30 * 86400;
const withdrawnPrefix = (grantId: string) => `relay-withdrawn:${grantId}:`;

export interface Withdrawn { answer_id: string; question_id: string; ask_id?: string; position?: number; withdrawn_on: string }

/** The relay mark's fields this needs (the `relays` row, migration 0082). */
export interface WithdrawnRelay { answer_id: string; grant_id: string; ask_id: string | null; ask_position: number | null }

export async function noteWithdrawn(env: Env, relay: WithdrawnRelay, questionId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const meta: Withdrawn = {
    answer_id: relay.answer_id, question_id: questionId, withdrawn_on: day,
    ...(relay.ask_id && relay.ask_position !== null ? { ask_id: relay.ask_id, position: Number(relay.ask_position) } : {}),
  };
  try {
    // Keyed by day so a listing (lexicographic, capped) keeps the oldest-first order; read newest-first below.
    await env.KV_USER_PROFILES.put(`${withdrawnPrefix(relay.grant_id)}${day}:${relay.answer_id}`, '', { expirationTtl: WITHDRAWN_TTL_S, metadata: meta });
  } catch (e) {
    console.warn('[relays] withdrawal note failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * The key's withdrawals in the last 30 days, newest first. KV listings are eventually consistent: a deletion
 * can take up to a minute to show. Past 1000 in 30 days, the oldest beyond that are left out.
 */
export async function listWithdrawn(env: Env, grantId: string): Promise<Withdrawn[]> {
  try {
    const { keys } = await env.KV_USER_PROFILES.list({ prefix: withdrawnPrefix(grantId), limit: 1000 });
    return (keys as Array<{ metadata?: unknown }>).map((k) => k.metadata as Withdrawn).filter((m) => !!m?.answer_id).reverse();
  } catch {
    return [];
  }
}

/** The ask item a deleted relay answered goes back to pending, so the agent can ask (or record) it again. */
export async function reopenAskItem(env: Env, ownerKey: number, relay: Pick<WithdrawnRelay, 'ask_id' | 'ask_position'>): Promise<void> {
  if (!relay.ask_id || relay.ask_position === null) return;
  try {
    const ask = await getAsk(env, ownerKey, relay.ask_id);
    await markItem(env, ownerKey, ask, Number(relay.ask_position), 'pending');
  } catch (e) {
    if (!(e instanceof AskError && e.status === 404)) throw e;
  }
}
