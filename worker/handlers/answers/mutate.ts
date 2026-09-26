/**
 * Mutation handlers for the answers API.
 *
 *  - PUT    /api/answers/:id  — handleUpdateAnswer
 *  - DELETE /api/answers/:id  — handleDeleteAnswer
 *
 * Both gate on author identity. Delete also evicts the sealed Q Storage
 * object and the Vectorize entry so a re-listed answer with the same id can
 * never appear in a similarity search.
 *
 * Audience transitions on update (docs/specs/private-answer-encryption.md §7.5):
 *   → Private / Allowlist   seal {value, answer_data, reasoning} into Q Storage;
 *                           the D1 row keeps the '[encrypted]' placeholder and
 *                           only the allowlist keys of answer_data; reasoning
 *                           and topics are NULLed; the Vectorize entry is dropped.
 *   Private / Allowlist →   plaintext back on the row, storage_ref cleared,
 *   Public / Anon           the sealed object deleted at once (decision §12.5).
 *   Public ↔ Anon           row update only.
 * Answer counts on the question move between pub_answers and priv_answers
 * only when the transition crosses the public/private line.
 *
 * Since 2026-09-08 (docs/specs/quiz-answer-audience.md §2.4–§2.5, card
 * t_6257699d) a re-scope also:
 *   - refuses to leave a person with two tallied rows (Public / Anon) of
 *     different audience on one question and scope (`AudienceStickyError`) —
 *     the latest-wins tally would move at that moment and link the anonymous
 *     vote to the name, the same hole `resolveStickyAudience` closes on create;
 *   - keeps `answer_meta` (privacy_tier, storage_ref, primary_value) and
 *     `anon_attributions` in step with the row, in the same D1 batch;
 *   - re-adds the Vectorize entry when the row becomes Public / Anon (Zoo,
 *     2026-09-08), with the text and metadata create.ts writes.
 * It never casts and never awards points.
 *
 * Closed waves are frozen (plan 2026-09-25 §8.6, ETHGlobal piece 3): once a
 * row's wave has closed, its tally may be committed to ENS + Arweave, so a
 * change that could move the tally is refused with 409 `wave_closed`. Value
 * edits, re-scopes into or out of the tally and deletes of tallied rows are
 * refused; Public → Anon with the value unchanged is allowed (tallied either
 * way, and it lets someone take their name off). A sealed row on a closed
 * wave can still be deleted: it was never in the tally or the bundle.
 *
 * `Answers` has no `updated_at` column in prod (card t_21462509); nothing here
 * binds one.
 */

import { VectorService } from '../../services/VectorService';
import { SecretStore } from '../../services/secret/SecretStore';
import { anonPlaceholderFid, anonTagReady } from '../../services/anon/AnonTag';
import {
  attributionStatement, authorTags, deleteAttributionStatement, isAuthor, ownRowsBinds, ownRowsDualSql,
} from '../../services/AnonAttributionService';
import { farcasterFidOf } from '../../services/accounts/AccountService';
import { getPoll, isPollClosed } from '../../services/PollService';
import {
  openSealedAnswer,
  parseAnswerData,
  sealedAnswerKey,
  storageKeyOf,
  stripAnswerDataContent,
  type Env,
} from './shared';

export type Audience = 'Public' | 'Private' | 'Anon' | 'Allowlist';
export type TalliedAudience = 'Public' | 'Anon';

/**
 * The change would give this person two tallied rows of different audience on
 * the same question and scope (docs/specs/quiz-answer-audience.md §2.4).
 * `existing` is the audience the other row(s) carry.
 */
export class AudienceStickyError extends Error {
  readonly code = 'audience_sticky' as const;
  readonly existing: TalliedAudience;
  constructor(existing: TalliedAudience) {
    super(`already answered ${existing === 'Anon' ? 'anonymously' : 'publicly'} on this question`);
    this.existing = existing;
  }
}

/** The row belongs to a wave that has closed; its tally is frozen (see header). */
export class WaveClosedError extends Error {
  readonly code = 'wave_closed' as const;
  constructor(readonly pollId: string) {
    super('this wave has closed; its answers can no longer change (you can still move a public answer to anon)');
  }
}

export interface AnswerUpdateBody {
  value: string;   // JSON string: {"text":...}, {"index":...}, {"indices":...}, {"value":...}
  audience: Audience;
  answer_type_id: number; // FK to answer_types table: 1=text, 2=mc, 3=scale, 4=checkbox
  answer_data?: Record<string, unknown> | null;
  allowlist_id?: string;
  allowlist?: number[];
  // Knowledge question fields (optional)
  reasoning?: string | null;
  topics?: string[] | null;
}

export interface ExistingAnswerRow {
  id: string;
  q_id: string;
  user_id: number;
  audience: string;
  answer_data?: unknown;
  reasoning?: string | null;
  topics?: string | null;
  storage_ref?: string | null;
  poll_id?: string | null;
  created_at?: string;
  primary_type?: string | null;
  [k: string]: unknown;
}

const AUDIENCES: Audience[] = ['Public', 'Private', 'Anon', 'Allowlist'];

function isSealedAudience(a: string): boolean {
  return a === 'Private' || a === 'Allowlist';
}

function isTallied(a: string): a is TalliedAudience {
  return a === 'Public' || a === 'Anon';
}

/** Whether the row sits on a wave that has closed. Direct answers (no poll_id) never freeze. */
export async function isOnClosedWave(env: Env, row: { poll_id?: unknown }): Promise<boolean> {
  const pollId = typeof row.poll_id === 'string' && row.poll_id ? row.poll_id : null;
  if (!pollId) return false;
  const poll = await getPoll(env.DB, pollId);
  return !!poll && isPollClosed(poll);
}

function sameAnswerData(existing: unknown, next: AnswerUpdateBody['answer_data']): boolean {
  if (next === undefined) return true; // not sent: the row keeps what it has
  const prior = parseAnswerData(existing);
  return JSON.stringify(prior ?? null) === JSON.stringify(next ?? null);
}

/**
 * Refuse a change to a row on a closed wave unless it leaves the tally as it
 * is: the same value in the same audience (a no-op), or Public → Anon with the
 * value unchanged.
 */
async function assertWaveOpenForUpdate(env: Env, existing: ExistingAnswerRow, body: AnswerUpdateBody): Promise<void> {
  if (!(await isOnClosedWave(env, existing))) return;
  const sameValue = !isSealedAudience(existing.audience)
    && String(existing.value) === String(body.value)
    && Number(existing.answer_type_id) === Number(body.answer_type_id)
    && sameAnswerData(existing.answer_data, body.answer_data);
  const allowed = sameValue && (body.audience === existing.audience || (existing.audience === 'Public' && body.audience === 'Anon'));
  if (!allowed) throw new WaveClosedError(String(existing.poll_id));
}

/**
 * One tallied audience per person, question and scope. A change to a sealed
 * audience always passes (sealed rows are outside the tally); a change to a
 * tallied one passes only when every other tallied row of this person there
 * already carries it. The earliest other row names `existing`.
 */
async function assertOneTalliedAudience(env: Env, existing: ExistingAnswerRow, to: Audience, actorKey: number, tags: string[] | null): Promise<void> {
  if (!isTallied(to) || existing.audience === to) return; // a plain edit changes no tally membership
  const scope = existing.poll_id ? 'AND a.poll_id = ?' : 'AND a.poll_id IS NULL';
  const binds: unknown[] = [existing.q_id, ...ownRowsBinds(actorKey, tags), existing.id];
  if (existing.poll_id) binds.push(existing.poll_id);
  const other = await env.DB.prepare(`
    SELECT a.audience FROM Answers a
    WHERE a.q_id = ? AND ${ownRowsDualSql('a')} AND a.id != ? AND a.audience IN ('Public', 'Anon') ${scope}
    ORDER BY a.created_at ASC, a.id ASC
    LIMIT 1
  `).bind(...binds).first() as { audience: string } | null;
  if (other && other.audience !== to) {
    throw new AudienceStickyError(isTallied(other.audience) ? other.audience : 'Public');
  }
}

/**
 * `answer_meta` mirrors the row: tier, where the content lives, and a public
 * preview. `responderFid` is a Farcaster fact (the anon placeholder on an
 * Anon row, the person's linked fid otherwise, NULL when they have none).
 */
function answerMetaSync(env: Env, id: string, audience: Audience, storageRef: string | null, value: string | null, responderFid: number | null) {
  const preview = isSealedAudience(audience) || value === null ? null : String(value).slice(0, 500);
  return env.DB.prepare(
    'UPDATE answer_meta SET privacy_tier = ?, storage_ref = ?, primary_value = ?, responder_fid = ? WHERE id = ?',
  ).bind(audience.toLowerCase(), storageRef, preview, responderFid, id);
}


/**
 * A row that is Public / Anon again belongs in similarity search like any
 * other: same text and metadata as create.ts, upserted so a refreshed audience
 * (Public ↔ Anon) replaces the entry. Best effort, as on create.
 */
async function upsertAnswerVector(env: Env, existing: ExistingAnswerRow, to: TalliedAudience, body: AnswerUpdateBody, rowFid: number): Promise<void> {
  try {
    const q = await env.DB.prepare('SELECT stem FROM queries WHERE id = ?').bind(existing.q_id).first() as { stem: string } | null;
    if (!q) return;
    const vectorService = VectorService.fromEnv(env);
    const values = await vectorService.vectorize(`Question: ${q.stem} Answer: ${body.value}`);
    await vectorService.upsertVectors([{
      id: existing.id,
      values,
      metadata: {
        q_id: existing.q_id,
        user_id: rowFid, // the anon placeholder on an Anon row, as on create
        audience: to,
        answer_type_id: body.answer_type_id,
        created_at: existing.created_at ?? new Date().toISOString(),
        primary_type: existing.primary_type ?? 'identity',
      },
    }], 'a');
  } catch (e) {
    console.error(`[Update Answer] failed to upsert vector for ${existing.id}:`, e);
  }
}

export interface ApplyAnswerUpdateOptions {
  /**
   * The person the row belongs to — a person key (fid before the account
   * cutover, account id after). Required when `existing` is an Anon row (its
   * `user_id` is the placeholder); defaults to `existing.user_id`.
   */
  actorFid?: number;
  /**
   * The Farcaster fid for `answer_meta.responder_fid` on a named row; null
   * for an account without one. Defaults to the fid linked to the actor.
   */
  responderFid?: number | null;
  /** The completion an Anon quiz row rejoins when it leaves Anon (it is unlinked while Anon). */
  quizCompletionId?: string | null;
}

/**
 * Apply an edit / re-scope to an existing row. Auth and ownership are the
 * caller's job; this is the storage transition, exported so it can be tested
 * against local D1 with an injected object store. Throws
 * `AudienceStickyError` before writing anything when the change would break
 * the one-tallied-audience rule.
 *
 * An Anon row carries the @4n0n placeholder in `user_id` and no
 * `quiz_completion_id`; the person is reachable only through the sealed
 * attribution. Leaving Anon restores both from `opts`.
 */
export async function applyAnswerUpdate(
  env: Env,
  existing: ExistingAnswerRow,
  body: AnswerUpdateBody,
  opts: ApplyAnswerUpdateOptions = {},
): Promise<{ storage: 'd1' | 'qstorage'; audience: Audience }> {
  const from = existing.audience;
  const to = body.audience;
  const wasSealed = isSealedAudience(from);
  const toSealed = isSealedAudience(to);
  const oldKey = wasSealed ? storageKeyOf(existing.storage_ref) : null;
  const actorFid = Number(opts.actorFid ?? existing.user_id); // the person key
  const tags = (await anonTagReady(env)) ? await authorTags(env, actorFid, existing.q_id) : null;
  // What the row carries after the change: the person key (or the anon placeholder) in user_id…
  const rowFid = to === 'Anon' ? anonPlaceholderFid(env) : actorFid;
  // …and the Farcaster fid in answer_meta.responder_fid (NULL for an account without one).
  const metaFid = to === 'Anon'
    ? rowFid
    : (opts.responderFid !== undefined ? opts.responderFid : ((await farcasterFidOf(env, actorFid)) ?? null));
  const rowCompletion = to === 'Anon'
    ? null
    : (opts.quizCompletionId !== undefined ? opts.quizCompletionId : ((existing.quiz_completion_id as string | null | undefined) ?? null));

  await assertWaveOpenForUpdate(env, existing, body);
  await assertOneTalliedAudience(env, existing, to, actorFid, tags);

  // The content the row holds today: for a sealed row it is in the envelope.
  // A sealed object that will not open is a real error (key, context) — refuse
  // rather than re-scope or delete content we cannot read. A missing object
  // (null) is not: there is nothing left to lose, so proceed with the row.
  let prior: { answer_data?: Record<string, unknown> | null; reasoning?: string | null } | null = null;
  if (wasSealed && oldKey) {
    try {
      prior = await openSealedAnswer(env, existing);
    } catch (e) {
      throw new Error(`sealed content for ${existing.id} would not open: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const priorAnswerData = prior?.answer_data ?? parseAnswerData(existing.answer_data);
  const priorReasoning = prior?.reasoning ?? existing.reasoning ?? null;

  let answerData: Record<string, unknown> | null =
    body.answer_data !== undefined ? body.answer_data : priorAnswerData;
  if (to === 'Allowlist' && Array.isArray(body.allowlist)) {
    answerData = { ...(answerData ?? {}), allowlist: body.allowlist };
  }
  const reasoning = body.reasoning !== undefined ? body.reasoning : priorReasoning;
  const topics = body.topics !== undefined
    ? (body.topics ? JSON.stringify(body.topics) : null)
    : (existing.topics ?? null);

  if (toSealed) {
    const newKey = sealedAnswerKey(to, existing.id);
    await SecretStore.putJSON(env, newKey, { value: body.value, answer_data: answerData, reasoning }, {
      tier: to,
      owner: rowFid,
      meta: {
        'q-id': existing.q_id,
        'user-id': String(rowFid),
        'audience': to,
        'answer-type-id': String(body.answer_type_id),
      },
    });
    if (oldKey && oldKey !== newKey) {
      try {
        await SecretStore.deleteObject(env, oldKey);
      } catch (e) {
        console.error(`[Update Answer] failed to delete old sealed object ${oldKey}:`, e);
      }
    }

    const stmts = [
      env.DB.prepare(`
        UPDATE Answers
        SET value = '[encrypted]', answer_type_id = ?, audience = ?, storage_ref = ?,
            reasoning = NULL, topics = NULL, answer_data = ?, user_id = ?, quiz_completion_id = ?
        WHERE id = ?
      `).bind(
        String(body.answer_type_id),
        to,
        `qstorage:${newKey}`,
        stripAnswerDataContent(answerData),
        rowFid,
        rowCompletion,
        existing.id,
      ),
      answerMetaSync(env, existing.id, to, `qstorage:${newKey}`, null, metaFid),
    ];
    if (!wasSealed) {
      stmts.push(env.DB.prepare(
        'UPDATE queries SET pub_answers = MAX(0, pub_answers - 1), priv_answers = priv_answers + 1 WHERE id = ?'
      ).bind(existing.q_id));
    }
    if (from === 'Anon') stmts.push(deleteAttributionStatement(env, existing.id));
    await env.DB.batch(stmts);

    if (!wasSealed) {
      // A public-era embedding would keep the content searchable.
      try {
        await VectorService.fromEnv(env).deleteVectors([existing.id], 'a');
      } catch (e) {
        console.error(`[Update Answer] failed to delete vector for ${existing.id}:`, e);
      }
    }
    return { storage: 'qstorage', audience: to };
  }

  // → Public / Anon: plaintext on the row.
  const stmts = [
    env.DB.prepare(`
      UPDATE Answers
      SET value = ?, answer_type_id = ?, audience = ?, storage_ref = NULL,
          reasoning = ?, topics = ?, answer_data = ?, user_id = ?, quiz_completion_id = ?
      WHERE id = ?
    `).bind(
      body.value,
      String(body.answer_type_id),
      to,
      reasoning ?? null,
      topics,
      answerData ? JSON.stringify(answerData) : null,
      rowFid,
      rowCompletion,
      existing.id,
    ),
    answerMetaSync(env, existing.id, to, null, body.value, metaFid),
  ];
  if (wasSealed) {
    stmts.push(env.DB.prepare(
      'UPDATE queries SET priv_answers = MAX(0, priv_answers - 1), pub_answers = pub_answers + 1 WHERE id = ?'
    ).bind(existing.q_id));
  }
  if (to === 'Anon' && from !== 'Anon') {
    stmts.push(await attributionStatement(env, { public_id: existing.id, fid: actorFid, type: 'answer', scope_id: existing.q_id }));
  }
  if (from === 'Anon' && to !== 'Anon') stmts.push(deleteAttributionStatement(env, existing.id));
  await env.DB.batch(stmts);

  if (wasSealed && oldKey) {
    try {
      await SecretStore.deleteObject(env, oldKey);
    } catch (e) {
      console.error(`[Update Answer] failed to delete sealed object ${oldKey}:`, e);
    }
  }
  await upsertAnswerVector(env, existing, to as TalliedAudience, body, rowFid); // not sealed ⇒ Public | Anon
  return { storage: 'd1', audience: to };
}

/**
 * PUT /api/answers/:id - Update an existing identity answer
 * Auth: Required - can only update your own answers. `requesterKey` is the
 * caller's person key (auth.userKey from the route's requireFlexibleAuth).
 */
export async function handleUpdateAnswer(
  request: Request,
  env: Env,
  answerId: string,
  requesterKey?: number,
): Promise<Response> {
  try {
    if (requesterKey === undefined) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Get requester's profile row (keyed by the person key)
    const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
      .bind(requesterKey)
      .first() as { fid: number } | null;

    if (!userRow) {
      return new Response('User not found', { status: 404 });
    }

    const userId = userRow.fid;

    const body = await request.json() as AnswerUpdateBody;

    // Validate required fields
    if (!body.value || !body.audience || !body.answer_type_id) {
      return new Response('Missing required fields', { status: 400 });
    }
    if (!AUDIENCES.includes(body.audience)) {
      return new Response('Invalid audience', { status: 400 });
    }

    const existingAnswer = await env.DB.prepare(
      'SELECT * FROM Answers WHERE id = ?'
    ).bind(answerId).first() as ExistingAnswerRow | null;

    if (!existingAnswer) {
      return new Response('Answer not found', { status: 404 });
    }

    // Verify ownership — an Anon row is the requester's only through its attribution
    const owns = existingAnswer.audience === 'Anon'
      ? await isAuthor(env, answerId, userId, existingAnswer.q_id, 'answer')
      : Number(existingAnswer.user_id) === userId;
    if (!owns) {
      return new Response('Forbidden: You can only update your own answers', { status: 403 });
    }

    // Check if this is a predictive answer (immutable)
    const question = await env.DB.prepare(
      'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
    ).bind(existingAnswer.q_id).first() as { primary_type?: string } | null;

    if (question?.primary_type === 'predictive') {
      return new Response('Predictive answers cannot be edited after submission', { status: 403 });
    }

    let result: { storage: 'd1' | 'qstorage'; audience: Audience };
    try {
      result = await applyAnswerUpdate(env, existingAnswer, body, { actorFid: userId });
    } catch (e) {
      if (e instanceof AudienceStickyError) {
        return Response.json({ error: e.message, code: e.code, existing: e.existing }, { status: 409 });
      }
      if (e instanceof WaveClosedError) {
        return Response.json({ error: e.message, code: e.code, poll_id: e.pollId }, { status: 409 });
      }
      throw e;
    }
    const changedAudience = result.audience !== existingAnswer.audience;

    return Response.json({
      success: true,
      answerId,
      storage: result.storage,
      audience: result.audience,
      message: changedAudience ? 'Answer audience changed successfully' : 'Answer updated successfully',
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error updating answer:', e);
    return new Response(`Error updating answer: ${err.message}`, { status: 500 });
  }
}

/** DELETE /api/answers/:id. `requesterFid` is the caller's person key (auth.userKey). */
export async function handleDeleteAnswer(answerId: string, env: Env, requesterFid: number): Promise<Response> {
  try {
    // Fetch the answer + question info for ownership check
    const answer = await env.DB.prepare(
      `SELECT a.*, q.coiner_fid FROM Answers a LEFT JOIN queries q ON a.q_id = q.id WHERE a.id = ?`
    ).bind(answerId).first() as Record<string, unknown> | null;

    if (!answer) {
      return new Response('Answer not found', { status: 404 });
    }

    // Verify ownership — only the answer's author can delete
    if (Number(answer.user_id) !== requesterFid && answer.audience !== 'Anon') {
      return new Response('Not authorized to delete this answer', { status: 403 });
    }

    // For anon answers, the attribution tag decides
    if (answer.audience === 'Anon' && !(await isAuthor(env, answerId, requesterFid, String(answer.q_id), 'answer'))) {
      return new Response('Not authorized to delete this answer', { status: 403 });
    }

    // A tallied row on a closed wave is part of a result that may be committed
    if ((answer.audience === 'Public' || answer.audience === 'Anon') && (await isOnClosedWave(env, answer))) {
      const e = new WaveClosedError(String(answer.poll_id));
      return Response.json({ error: e.message, code: e.code, poll_id: e.pollId }, { status: 409 });
    }

    // Delete from Vectorize (AINDEX) — best effort
    try {
      const vectorService = VectorService.fromEnv(env);
      await vectorService.deleteVectors([answerId], 'a');
      console.log(`[Delete Answer] Deleted vector for ${answerId}`);
    } catch (e) {
      console.error(`[Delete Answer] Failed to delete vector for ${answerId}:`, e);
    }

    // Delete the sealed object if Private/Allowlist
    if (answer.audience === 'Private' || answer.audience === 'Allowlist') {
      try {
        const storageKey = storageKeyOf(answer.storage_ref);
        if (storageKey) {
          await SecretStore.deleteObject(env, storageKey);
          console.log(`[Delete Answer] Deleted sealed object for ${answerId}`);
        }
      } catch (e) {
        console.error(`[Delete Answer] Failed to delete sealed object for ${answerId}:`, e);
      }
    }

    // Delete related records. answer_allowlists is referenced elsewhere
    // (create.ts:478, read.ts:115) but the table doesn't exist in this
    // schema — allowlist data lives on Answers.allowlist_data per
    // migration 0017. Those two references are still broken; tracked
    // separately. Removed the matching DELETE here so legitimate
    // delete-answer requests stop 500'ing.
    await env.DB.prepare('DELETE FROM answer_likes WHERE answer_id = ?').bind(answerId).run();
    await env.DB.prepare('DELETE FROM answer_meta WHERE id = ?').bind(answerId).run();
    await env.DB.prepare("DELETE FROM anon_attributions WHERE public_id = ? AND type = 'answer'").bind(answerId).run();

    // Delete the answer itself
    await env.DB.prepare('DELETE FROM Answers WHERE id = ?').bind(answerId).run();

    // Update answer count
    const audience = answer.audience as string;
    if (audience === 'Public' || audience === 'Anon') {
      await env.DB.prepare(
        'UPDATE queries SET pub_answers = MAX(0, pub_answers - 1) WHERE id = ?'
      ).bind(answer.q_id).run();
    } else {
      await env.DB.prepare(
        'UPDATE queries SET priv_answers = MAX(0, priv_answers - 1) WHERE id = ?'
      ).bind(answer.q_id).run();
    }

    console.log(`[Delete Answer] Deleted answer ${answerId}`);

    return Response.json({ success: true });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error deleting answer:', e);
    return new Response(`Error deleting answer: ${err.message || 'Unknown error'}`, { status: 500 });
  }
}
