/**
 * The protected action behind the approval gate (plan §6.2 step 6): an
 * approved agent draft becomes a live wave, and @polls announces it.
 *
 * The wave is opened through the same `openWave` path as `POST /api/polls`,
 * so an agent's wave obeys every rule a person's does (close-time bounds,
 * gate validation and resolution, open options). The launch cast is real only
 * where `AGENT_PUBLISH_CAST=1`; elsewhere (staging) it is a dry-run log line,
 * so a sandbox approval, which proves nothing about a real person, never
 * reaches a real feed.
 *
 * Publishing is claimed with a conditional UPDATE (approved → publishing), so
 * two concurrent status reads cannot open two waves for one draft.
 */

import { openWave, validateCloseTime, validateGateSubmission } from './WaveService';
import { setPollCastHash, type PollRow } from './PollService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/** A wave as an agent drafts it. Exactly one of closes_in_h / closes_at. */
export interface DraftWave {
  closes_in_h?: number;
  closes_at?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eligibility_gate?: any;
  options_config?: unknown;
  channel_id?: string;
}

const MAX_CLOSES_IN_H = 365 * 24;

/**
 * Check a drafted wave when the agent submits it, so an agent learns about a
 * bad close time or gate before its owner is asked to approve anything.
 * Returns the normalized wave, or an error message.
 */
export function validateDraftWave(raw: unknown): { ok: true; wave: DraftWave } | { ok: false; error: string; code: string } {
  const w = (raw ?? {}) as Record<string, unknown>;
  const out: DraftWave = {};
  const hasIn = w.closes_in_h !== undefined;
  const hasAt = w.closes_at !== undefined;
  if (hasIn === hasAt) {
    return { ok: false, error: 'wave needs exactly one of closes_in_h or closes_at', code: 'close_time_required' };
  }
  if (hasIn) {
    const h = Number(w.closes_in_h);
    if (!Number.isFinite(h) || h <= 0 || h > MAX_CLOSES_IN_H) {
      return { ok: false, error: `closes_in_h must be between 0 and ${MAX_CLOSES_IN_H}`, code: 'close_time_invalid' };
    }
    out.closes_in_h = h;
  } else {
    const err = validateCloseTime(w.closes_at);
    if (err) return { ok: false, error: err.error, code: err.code ?? 'wave_invalid' };
    out.closes_at = String(w.closes_at);
  }
  if (w.eligibility_gate !== undefined && w.eligibility_gate !== null) {
    const err = validateGateSubmission(w.eligibility_gate);
    if (err) return { ok: false, error: err.error, code: err.code ?? 'wave_invalid' };
    out.eligibility_gate = w.eligibility_gate;
  }
  if (w.options_config !== undefined && w.options_config !== null) out.options_config = w.options_config;
  if (w.channel_id !== undefined) {
    if (typeof w.channel_id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(w.channel_id)) {
      return { ok: false, error: 'channel_id must be a Farcaster channel id', code: 'channel_invalid' };
    }
    out.channel_id = w.channel_id;
  }
  return { ok: true, wave: out };
}

export type PublishResult =
  | { status: 'published'; poll_id: string; cast: 'sent' | 'dry_run' | 'failed' }
  | { status: 'publish_failed'; error: string }
  | { status: 'not_claimed' };

/** The Farcaster account an agent acts as, for `polls.author_fid`. */
function agentFid(env: Env, agentId: string): number | null {
  if (agentId === 'qgent') {
    const n = Number(env.QGENT_FID);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Publish an approved draft: claim it, open the wave, announce it. A no-op
 * (`not_claimed`) unless the draft is `approved` right now.
 */
export async function publishApprovedDraft(env: Env, draftId: string, nowMs: number = Date.now()): Promise<PublishResult> {
  const claim = await env.DB.prepare(
    "UPDATE agent_wave_drafts SET status = 'publishing' WHERE id = ? AND status = 'approved'",
  ).bind(draftId).run();
  if (!claim?.meta?.changes) return { status: 'not_claimed' };

  const draft = await env.DB.prepare('SELECT * FROM agent_wave_drafts WHERE id = ?').bind(draftId).first() as
    { id: string; agent_id: string; question_id: string; wave: string } | null;
  if (!draft) return { status: 'not_claimed' };

  const fail = async (error: string): Promise<PublishResult> => {
    await env.DB.prepare(
      "UPDATE agent_wave_drafts SET status = 'publish_failed', publish_error = ? WHERE id = ? AND status = 'publishing'",
    ).bind(error, draftId).run();
    console.warn('[agent-publish] draft', draftId, 'failed:', error);
    return { status: 'publish_failed', error };
  };

  let wave: DraftWave;
  try {
    wave = JSON.parse(draft.wave) as DraftWave;
  } catch {
    return fail('wave_unreadable');
  }
  const closesAt = wave.closes_at
    ?? new Date(nowMs + Number(wave.closes_in_h) * 3600 * 1000).toISOString();

  let opened;
  try {
    opened = await openWave(env, {
      question_id: draft.question_id,
      closes_at: closesAt,
      eligibility_gate: wave.eligibility_gate ?? null,
      options_config: wave.options_config ?? null,
      channel_id: wave.channel_id ?? null,
      author_fid: agentFid(env, draft.agent_id),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'open_wave_error');
  }
  if (!opened.ok) return fail(opened.code ?? opened.error);

  await env.DB.prepare(
    "UPDATE agent_wave_drafts SET status = 'published', poll_id = ?, publish_error = NULL WHERE id = ? AND status = 'publishing'",
  ).bind(opened.poll.id, draftId).run();

  const cast = await announce(env, draft.agent_id, opened.poll, opened.question);
  return { status: 'published', poll_id: opened.poll.id, cast };
}

/** The launch cast's text: the question, its options, and who asked. */
export function launchCastText(
  agentId: string,
  stem: string,
  options: string[],
  gate: { type?: string } | null,
): string {
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  const lines = [stem.trim()];
  if (options.length) lines.push('', ...options.map((o, i) => `${marks[i] ?? '•'} ${o}`));
  lines.push('', `Drafted by @${agentId}, approved by its owner with World ID.`);
  if (gate?.type === 'world_id') lines.push('Verified humans only: one person, one answer.');
  return lines.join('\n');
}

async function announce(
  env: Env,
  agentId: string,
  poll: PollRow,
  question: { id: string; a_options: string[] },
): Promise<'sent' | 'dry_run' | 'failed'> {
  const row = await env.DB.prepare('SELECT stem FROM queries WHERE id = ?').bind(question.id).first() as { stem: string } | null;
  let gate: { type?: string } | null = null;
  try { gate = poll.eligibility_gate ? JSON.parse(String(poll.eligibility_gate)) : null; } catch { /* no gate line */ }
  const text = launchCastText(agentId, row?.stem ?? '', question.a_options, gate);
  const host = typeof env.HOSTNAME === 'string' && env.HOSTNAME ? env.HOSTNAME : 'qbase.tech';
  const embed = `https://${host}/snap/poll/${poll.id}`;

  if (env.AGENT_PUBLISH_CAST !== '1') {
    console.log('[agent-publish] dry run: @polls would cast', JSON.stringify({ poll_id: poll.id, text, embed }));
    return 'dry_run';
  }
  try {
    const { initCastRouter } = await import('./casting');
    const router = initCastRouter(env);
    const result = await router.publish({
      fid: Number(env.POLLS_FID) || 3321680,
      text,
      embeds: [{ url: embed }],
    }, env);
    if (result.hash) await setPollCastHash(env.DB, poll.id, result.hash);
    return 'sent';
  } catch (e) {
    // The wave is live either way; a failed announcement is logged, not undone.
    console.error('[agent-publish] launch cast failed for', poll.id, e instanceof Error ? e.message : e);
    return 'failed';
  }
}
