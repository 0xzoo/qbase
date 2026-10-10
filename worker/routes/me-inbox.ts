/**
 * The owner's inbox (docs/specs/personal-mcp.md §3.3): what their agents
 * asked them through ask_owner, answered here.
 *
 *   GET  /api/me/inbox?status=pending|answered|declined|all   → { asks, pending }
 *   GET  /api/me/inbox?count=1                                 → { pending, keys }   (header badge; opens nothing)
 *   POST /api/me/inbox/:askId/items/:pos        { answer, reasoning?, audience? }   → { ok, audience }
 *   POST /api/me/inbox/:askId/items/:pos/skip   → { ok }
 *   POST /api/me/inbox/:askId/decline           → { ok }
 *
 * A public item is answered through the normal answer path (handleCreateAnswer)
 * at the tier the owner picks: Secret by default, Anon or Public if they say
 * so; sticky audiences and points behave as anywhere else. An owner-only item
 * is answered into owner_answers and is always Secret.
 *
 * Signed-in owner only (session / Quick Auth). An agent key can't reach these:
 * requireFlexibleAuth doesn't accept one, so an agent can't answer its own ask.
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { handleCreateAnswer } from '../handlers/answers';
import {
  AskError, answerOwnerQuestion, declineAsk, getAsk, isOwnerQuestionId, listAsks, markItem, normaliseAnswer, resolveQuestions,
  validReasoning, type AskStatus,
} from '../services/personal/AskService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const AUDIENCE: Record<string, 'Private' | 'Anon' | 'Public'> = { Secret: 'Private', Anon: 'Anon', Public: 'Public' };

export async function handleMeInboxRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/me\/inbox(?:\/([0-9a-f-]{36})(?:\/(decline)|\/items\/(\d+)(\/skip)?)?)?$/);
  if (!m) return null;

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const owner = auth.userKey;
  const [, askId, decline, posRaw, skip] = m;

  try {
    if (!askId && request.method === 'GET' && url.searchParams.get('count')) {
      const row = await env.DB.prepare(`
        SELECT (SELECT COUNT(*) FROM asks WHERE owner_key = ?1 AND status = 'pending') AS pending,
               (SELECT COUNT(*) FROM grants WHERE owner_key = ?1 AND revoked_at IS NULL) AS keys
      `).bind(owner).first() as { pending: number; keys: number } | null;
      return Response.json({ pending: row?.pending ?? 0, keys: row?.keys ?? 0 });
    }

    if (!askId && request.method === 'GET') {
      const status = (url.searchParams.get('status') ?? 'pending') as AskStatus | 'all';
      if (!['pending', 'answered', 'declined', 'all'].includes(status)) return Response.json({ error: 'bad status' }, { status: 400 });
      const asks = await listAsks(env, { ownerKey: owner, status });
      const questions = await resolveQuestions(env, owner, [...new Set(asks.flatMap((a) => a.items.map((i) => i.question_id)))]);
      const grantIds = [...new Set(asks.map((a) => a.grant_id))];
      const grants = new Map<string, { label: string | null; ceiling: string; disclosure: string }>();
      if (grantIds.length) {
        const { results } = await env.DB.prepare(`SELECT id, label, ceiling, disclosure FROM grants WHERE owner_key = ? AND id IN (${grantIds.map(() => '?').join(',')})`)
          .bind(owner, ...grantIds).all();
        for (const g of (results ?? []) as Array<{ id: string; label: string | null; ceiling: string; disclosure: string }>) grants.set(g.id, g);
      }
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM asks WHERE owner_key = ? AND status = 'pending'").bind(owner).first() as { n: number } | null;
      return Response.json({
        pending: pending?.n ?? 0,
        asks: asks.map((a) => ({
          id: a.id, status: a.status, created_at: a.created_at, agent: grants.get(a.grant_id)?.label ?? 'an agent',
          // What the asking key can read back, so the owner knows which answers it will see.
          agent_reads: grants.has(a.grant_id) ? { ceiling: grants.get(a.grant_id)!.ceiling, disclosure: grants.get(a.grant_id)!.disclosure } : null,
          decision: a.decision, why_needed: a.why_needed, note: a.note,
          items: a.items.map((it, position) => ({ position, ...it, question: questions.get(it.question_id) ?? null })),
        })),
      });
    }

    if (request.method !== 'POST' || !askId) return null;

    if (decline) {
      await declineAsk(env, owner, askId);
      return Response.json({ ok: true });
    }

    const ask = await getAsk(env, owner, askId);
    if (ask.status === 'declined') return Response.json({ error: 'this ask was declined' }, { status: 409 });
    const position = Number(posRaw);
    const item = ask.items[position];
    if (!item) return Response.json({ error: 'no such item' }, { status: 404 });
    if (item.answered || item.skipped) return Response.json({ error: `already ${item.answered ? 'answered' : 'skipped'}` }, { status: 409 });

    if (skip) {
      const next = await markItem(env, owner, ask, position, 'skipped');
      return Response.json({ ok: true, status: next.status });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const q = (await resolveQuestions(env, owner, [item.question_id])).get(item.question_id);
    if (!q) return Response.json({ error: 'the question is gone' }, { status: 410 });
    const answer = normaliseAnswer(q, body.answer);
    const reasoning = validReasoning(body.reasoning);

    let audience: 'Private' | 'Anon' | 'Public' = 'Private';
    if (isOwnerQuestionId(item.question_id)) {
      await answerOwnerQuestion(env, owner, item.question_id, answer.value, reasoning);
    } else {
      audience = AUDIENCE[String(body.audience ?? 'Secret')];
      if (!audience) return Response.json({ error: 'audience must be Secret, Anon or Public' }, { status: 400 });
      if (auth.fid !== undefined && !(await ensureUserExists(env, auth.fid))) {
        return Response.json({ error: 'could not load your profile' }, { status: 500 });
      }
      const res = await handleCreateAnswer(new Request(new URL('/api/answers', url).toString(), {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({
          q_id: q.id, value: answer.value, answer_type_id: answer.answer_type_id,
          ...(answer.answer_data ? { answer_data: answer.answer_data } : {}),
          ...(reasoning ? { reasoning } : {}),
          audience, user_id: owner,
        }),
      }), env);
      if (!res.ok) {
        const text = await res.text();
        let error = text;
        try { error = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
        return Response.json({ error: error || 'could not save the answer' }, { status: res.status });
      }
      const saved = await res.json() as { audience?: string };
      // Sticky audience: the first public/anon choice on a question holds (AudienceService).
      if (saved.audience === 'Anon' || saved.audience === 'Public') audience = saved.audience;
    }

    const next = await markItem(env, owner, ask, position, 'answered');
    return Response.json({ ok: true, status: next.status, audience: audience === 'Private' ? 'Secret' : audience });
  } catch (e) {
    if (e instanceof AskError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[me-inbox] failed:', e);
    return Response.json({ error: 'Inbox failed' }, { status: 500 });
  }
}
