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
 * Relayed answers (record_answer, migration 0082): what an agent recorded from a conversation,
 * Secret and marked until the owner confirms it. GET lists them as `relays`; the count includes them.
 *   POST /api/me/inbox/relays/:answerId/confirm  { answer?, reasoning?, audience? }  → { ok, audience, answer_id }
 *   POST /api/me/inbox/relays/:answerId/delete   → { ok }
 *   POST /api/me/inbox/relays/confirm-all        → { ok, confirmed }
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
import { confirmAll, confirmRelay, deleteRelay, listRelays } from '../services/personal/RelayService';
import { AudienceStickyError } from '../handlers/answers/mutate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const AUDIENCE: Record<string, 'Private' | 'Anon' | 'Public'> = { Secret: 'Private', Anon: 'Anon', Public: 'Public' };

async function grantLabels(env: Env, owner: number, ids: string[]) {
  const grants = new Map<string, { label: string | null; ceiling: string; disclosure: string }>();
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT id, label, ceiling, disclosure FROM grants WHERE owner_key = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(owner, ...ids).all();
    for (const g of (results ?? []) as Array<{ id: string; label: string | null; ceiling: string; disclosure: string }>) grants.set(g.id, g);
  }
  return grants;
}

async function handleRelays(request: Request, env: Env, owner: number, answerId: string | undefined, action: string): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (action === 'confirm-all') return Response.json({ ok: true, confirmed: await confirmAll(env, owner) });
  if (action === 'delete') {
    await deleteRelay(env, owner, answerId!);
    return Response.json({ ok: true });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const r = await confirmRelay(env, owner, answerId!, { answer: body.answer, reasoning: body.reasoning, audience: body.audience }, new URL(request.url).origin);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof AudienceStickyError) return Response.json({ error: e.message, code: e.code }, { status: 409 });
    throw e;
  }
}

export async function handleMeInboxRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const relay = url.pathname.match(/^\/api\/me\/inbox\/relays\/(?:(confirm-all)|([0-9a-f-]{36})\/(confirm|delete))$/);
  const m = relay ? null : url.pathname.match(/^\/api\/me\/inbox(?:\/([0-9a-f-]{36})(?:\/(decline)|\/items\/(\d+)(\/skip)?)?)?$/);
  if (!m && !relay) return null;

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const owner = auth.userKey;

  try {
    if (relay) return await handleRelays(request, env, owner, relay[2], relay[1] ?? relay[3]);
    const [, askId, decline, posRaw, skip] = m!;

    if (!askId && request.method === 'GET' && url.searchParams.get('count')) {
      const row = await env.DB.prepare(`
        SELECT (SELECT COUNT(*) FROM asks WHERE owner_key = ?1 AND status = 'pending') AS asks,
               (SELECT COUNT(*) FROM relays WHERE owner_key = ?1) AS relays,
               (SELECT COUNT(*) FROM grants WHERE owner_key = ?1 AND revoked_at IS NULL) AS keys
      `).bind(owner).first() as { asks: number; relays: number; keys: number } | null;
      const asks = row?.asks ?? 0, relays = row?.relays ?? 0;
      return Response.json({ pending: asks + relays, asks, relays, keys: row?.keys ?? 0 });
    }

    if (!askId && request.method === 'GET') {
      const status = (url.searchParams.get('status') ?? 'pending') as AskStatus | 'all';
      if (!['pending', 'answered', 'declined', 'all'].includes(status)) return Response.json({ error: 'bad status' }, { status: 400 });
      const asks = await listAsks(env, { ownerKey: owner, status });
      const questions = await resolveQuestions(env, owner, [...new Set(asks.flatMap((a) => a.items.map((i) => i.question_id)))]);
      const relays = await listRelays(env, owner);
      const grants = await grantLabels(env, owner, [...new Set([...asks.map((a) => a.grant_id), ...relays.map((r) => r.grant_id)])]);
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
        relays: relays.map(({ grant_id, ...r }) => ({ ...r, agent: grants.get(grant_id)?.label ?? 'an agent' })),
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
