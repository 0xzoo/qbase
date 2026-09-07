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
 * `Answers` has no `updated_at` column in prod (card t_21462509); nothing here
 * binds one.
 */

import { AuthService } from '../../services/AuthService';
import { VectorService } from '../../services/VectorService';
import { SecretStore } from '../../services/secret/SecretStore';
import {
  openSealedAnswer,
  parseAnswerData,
  sealedAnswerKey,
  storageKeyOf,
  stripAnswerDataContent,
  type Env,
} from './shared';

export type Audience = 'Public' | 'Private' | 'Anon' | 'Allowlist';

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
  [k: string]: unknown;
}

const AUDIENCES: Audience[] = ['Public', 'Private', 'Anon', 'Allowlist'];

function isSealedAudience(a: string): boolean {
  return a === 'Private' || a === 'Allowlist';
}

/**
 * Apply an edit / re-scope to an existing row. Auth and ownership are the
 * caller's job; this is the storage transition, exported so it can be tested
 * against local D1 with an injected object store.
 */
export async function applyAnswerUpdate(
  env: Env,
  existing: ExistingAnswerRow,
  body: AnswerUpdateBody,
): Promise<{ storage: 'd1' | 'qstorage'; audience: Audience }> {
  const from = existing.audience;
  const to = body.audience;
  const wasSealed = isSealedAudience(from);
  const toSealed = isSealedAudience(to);
  const oldKey = wasSealed ? storageKeyOf(existing.storage_ref) : null;

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
      owner: existing.user_id,
      meta: {
        'q-id': existing.q_id,
        'user-id': String(existing.user_id),
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

    await env.DB.prepare(`
      UPDATE Answers
      SET value = '[encrypted]', answer_type_id = ?, audience = ?, storage_ref = ?,
          reasoning = NULL, topics = NULL, answer_data = ?
      WHERE id = ?
    `).bind(
      String(body.answer_type_id),
      to,
      `qstorage:${newKey}`,
      stripAnswerDataContent(answerData),
      existing.id,
    ).run();

    if (!wasSealed) {
      await env.DB.prepare(
        'UPDATE queries SET pub_answers = MAX(0, pub_answers - 1), priv_answers = priv_answers + 1 WHERE id = ?'
      ).bind(existing.q_id).run();
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
  await env.DB.prepare(`
    UPDATE Answers
    SET value = ?, answer_type_id = ?, audience = ?, storage_ref = NULL,
        reasoning = ?, topics = ?, answer_data = ?
    WHERE id = ?
  `).bind(
    body.value,
    String(body.answer_type_id),
    to,
    reasoning ?? null,
    topics,
    answerData ? JSON.stringify(answerData) : null,
    existing.id,
  ).run();

  if (wasSealed) {
    if (oldKey) {
      try {
        await SecretStore.deleteObject(env, oldKey);
      } catch (e) {
        console.error(`[Update Answer] failed to delete sealed object ${oldKey}:`, e);
      }
    }
    await env.DB.prepare(
      'UPDATE queries SET priv_answers = MAX(0, priv_answers - 1), pub_answers = pub_answers + 1 WHERE id = ?'
    ).bind(existing.q_id).run();
  }
  return { storage: 'd1', audience: to };
}

/**
 * PUT /api/answers/:id - Update an existing identity answer
 * Auth: Required - can only update your own answers
 */
export async function handleUpdateAnswer(
  request: Request,
  env: Env,
  answerId: string
): Promise<Response> {
  try {
    // Verify authentication
    const authService = AuthService.fromEnv(env, request.url);
    const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

    if (!auth.valid || !auth.fid) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Get requester's internal user ID
    const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
      .bind(auth.fid)
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

    // Verify ownership
    if (existingAnswer.user_id !== userId) {
      return new Response('Forbidden: You can only update your own answers', { status: 403 });
    }

    // Check if this is a predictive answer (immutable)
    const question = await env.DB.prepare(
      'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
    ).bind(existingAnswer.q_id).first() as { primary_type?: string } | null;

    if (question?.primary_type === 'predictive') {
      return new Response('Predictive answers cannot be edited after submission', { status: 403 });
    }

    const result = await applyAnswerUpdate(env, existingAnswer, body);
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

    // For anon answers, check attribution
    if (answer.audience === 'Anon') {
      const { AnonAttributionService } = await import('../../services/AnonAttributionService');
      const attributions = await AnonAttributionService.getUserAnonymousContent(env, requesterFid);
      const ownedAnonIds = new Set(attributions.filter(a => a.type === 'answer').map(a => a.public_id));
      if (!ownedAnonIds.has(answerId)) {
        return new Response('Not authorized to delete this answer', { status: 403 });
      }
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

    console.log(`[Delete Answer] Deleted answer ${answerId} by user ${requesterFid}`);

    return Response.json({ success: true });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error deleting answer:', e);
    return new Response(`Error deleting answer: ${err.message || 'Unknown error'}`, { status: 500 });
  }
}
