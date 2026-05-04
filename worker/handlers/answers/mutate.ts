/**
 * Mutation handlers for the answers API.
 *
 *  - PUT    /api/answers/:id  — handleUpdateAnswer
 *  - DELETE /api/answers/:id  — handleDeleteAnswer
 *
 * Both gate on author identity. Delete also evicts QStorage blobs and
 * Vectorize entries so a re-listed answer with the same id can never
 * appear in a similarity search.
 */

import { AuthService } from '../../services/AuthService';
import { QStorageService } from '../../services/QStorageService';
import { VectorService } from '../../services/VectorService';
import { anon_id } from '../../../src/lib/consts';
import type { Env } from './shared';

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

    const body = await request.json() as {
      value: string;   // JSON string: {"text":...}, {"index":...}, {"indices":...}, {"value":...}
      audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
      answer_type_id: number; // FK to answer_types table: 1=text, 2=mc, 3=scale, 4=checkbox
      allowlist_id?: string;
      allowlist?: number[];
      // Knowledge question fields (optional)
      reasoning?: string;
      topics?: string[];
    };

    // Validate required fields
    if (!body.value || !body.audience || !body.answer_type_id) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Check if answer exists in D1 (Public answers)
    const existingAnswer = await env.DB.prepare(
      'SELECT * FROM Answers WHERE id = ?'
    ).bind(answerId).first();

    if (existingAnswer) {
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

      const now = new Date().toISOString();

      // If staying public, update in D1
      if (body.audience === 'Public') {
        await env.DB.prepare(`
          UPDATE Answers 
          SET value = ?, answer_type_id = ?, updated_at = ?, reasoning = ?, topics = ?
          WHERE id = ?
        `).bind(
          body.value,
          body.answer_type_id,
          now,
          body.reasoning || null,
          body.topics ? JSON.stringify(body.topics) : null,
          answerId
        ).run();

        return Response.json({
          success: true,
          answerId,
          message: 'Answer updated successfully'
        });
      } else {
        // Moving from Public to Private/Anon/Allowlist
        // Moving from Public to Private/Anon/Allowlist
        const now2 = new Date().toISOString();

        if (body.audience === 'Anon') {
          // Moving to Anon: update in D1 with anon user_id
          await env.DB.prepare(`
            UPDATE Answers SET value = ?, answer_type_id = ?, audience = 'Anon', user_id = ?, updated_at = ?
            WHERE id = ?
          `).bind(body.value, body.answer_type_id, anon_id, now2, answerId).run();
        } else {
          // Moving to Private/Allowlist: store value in Q Storage, update D1
          const storageKey = `answers/${body.audience.toLowerCase()}/${answerId}`;
          const qstorage = QStorageService.fromEnv(env);
          await qstorage.put(storageKey, JSON.stringify({
            value: body.value,
            answer_data: null,
            reasoning: body.reasoning,
          }), { 'audience': body.audience }, 'application/json');

          await env.DB.prepare(`
            UPDATE Answers SET value = '[encrypted]', answer_type_id = ?, audience = ?, updated_at = ?, storage_ref = ?
            WHERE id = ?
          `).bind(body.answer_type_id, body.audience, now2, `qstorage:${storageKey}`, answerId).run();

          // Decrement pub, increment priv
          await env.DB.prepare(
            'UPDATE queries SET pub_answers = pub_answers - 1, priv_answers = priv_answers + 1 WHERE id = ?'
          ).bind(existingAnswer.q_id).run();
        }

        return Response.json({
          success: true,
          answerId,
          storage: 'qstorage',
          message: 'Answer audience changed successfully'
        });
      }
    }

    // Answer not found in D1 — doesn't exist
    return new Response('Answer not found', { status: 404 });

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

    // Delete from QStorage if Private/Allowlist
    if (answer.audience === 'Private' || answer.audience === 'Allowlist') {
      try {
        const qstorage = QStorageService.fromEnv(env);
        if (answer.storage_ref && typeof answer.storage_ref === 'string') {
          const storageKey = answer.storage_ref.replace('qstorage:', '');
          await qstorage.delete(storageKey);
          console.log(`[Delete Answer] Deleted QStorage blob for ${answerId}`);
        }
      } catch (e) {
        console.error(`[Delete Answer] Failed to delete QStorage blob for ${answerId}:`, e);
      }
    }

    // Delete related records
    await env.DB.prepare('DELETE FROM answer_likes WHERE answer_id = ?').bind(answerId).run();
    await env.DB.prepare('DELETE FROM answer_meta WHERE id = ?').bind(answerId).run();
    await env.DB.prepare("DELETE FROM anon_attributions WHERE public_id = ? AND type = 'answer'").bind(answerId).run();
    await env.DB.prepare('DELETE FROM answer_allowlists WHERE answer_id = ?').bind(answerId).run();

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
