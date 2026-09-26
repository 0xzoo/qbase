/**
 * PollOptionsService — open-options waves (write-in multiple choice).
 *
 * An open wave (polls.options_config.open) keeps its option set open: a
 * respondent can vote an existing option or write in a new one, which becomes
 * a first-class, votable option stored as a `poll_options` row keyed by the
 * wave. A fresh wave on the same question starts from the question's declared
 * a_options (seeded at wave creation) and grows its own set — the option
 * space itself is per-wave data.
 *
 * The write-in also records the submitter's vote in the SAME append-only
 * Answers/answer_meta path as a normal MC vote (stamped with the wave's id),
 * so counting (AnswerCountService.getMcCounts) needs no special-casing.
 *
 * Callers MUST have ensured the voting user exists (FK on Answers.user_id)
 * and passed the wave's eligibility gate before invoking recordMcVote /
 * addOrVoteWriteIn.
 */

import type { PollRow } from './PollService';
import { anonPlaceholderFid, anonTagReady } from './anon/AnonTag';
import { anonWriteFor, authorTags } from './AnonAttributionService';
import { farcasterFidOf } from './accounts/AccountService';
import { getExistingAnswer } from './AnswerCountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export const DEFAULT_CAP = 24;
export const DEFAULT_WRITEINS_PER_USER = 1;
export const MAX_LABEL_LEN = 60;

export interface OptionsConfig {
  open: boolean;
  cap: number;
  writeins_per_user: number;
}

/** Public shape — created_by_fid is intentionally omitted (server-side only). */
export interface PollOption {
  id: string;
  label: string;
  source: 'seed' | 'writein';
  created_at: string;
  hidden: boolean;
}

interface PollOptionRow {
  id: string;
  poll_id: string;
  label: string;
  label_norm: string;
  source: string;
  created_by_fid: number | null;
  created_at: string;
  hidden: number;
}

/**
 * Parse polls.options_config. Returns null for a classic (closed) MC wave
 * — i.e. NULL column, malformed JSON, or `open !== true`. Caps are clamped to
 * sane defaults so a bad config can never disable the cap entirely.
 */
export function parseOptionsConfig(raw?: string | null): OptionsConfig | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || parsed.open !== true) return null;
    const cap = Number.isFinite(parsed.cap) && parsed.cap > 0 ? Math.floor(parsed.cap) : DEFAULT_CAP;
    const wpu = Number.isFinite(parsed.writeins_per_user) && parsed.writeins_per_user >= 0
      ? Math.floor(parsed.writeins_per_user)
      : DEFAULT_WRITEINS_PER_USER;
    return { open: true, cap, writeins_per_user: wpu };
  } catch {
    return null;
  }
}

/** Validate + normalize an options_config submission for the create path. */
export function buildOptionsConfig(raw: unknown): OptionsConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.open !== true) return null;
  const cap = typeof obj.cap === 'number' && obj.cap > 0 ? Math.floor(obj.cap) : DEFAULT_CAP;
  const wpu = typeof obj.writeins_per_user === 'number' && obj.writeins_per_user >= 0
    ? Math.floor(obj.writeins_per_user)
    : DEFAULT_WRITEINS_PER_USER;
  return { open: true, cap, writeins_per_user: wpu };
}

/** Normalize a label for dedup: trim, lowercase, collapse internal whitespace. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toPublic(row: PollOptionRow): PollOption {
  return {
    id: row.id,
    label: row.label,
    source: row.source === 'seed' ? 'seed' : 'writein',
    created_at: row.created_at,
    hidden: !!row.hidden,
  };
}

const OPTION_COLS =
  'id, poll_id, label, label_norm, source, created_by_fid, created_at, hidden';

/** Visible options for a wave, in declared order (seeds first, then write-ins by time). */
export async function listVisibleOptions(db: D1Database, pollId: string): Promise<PollOption[]> {
  const { results } = await db.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options
     WHERE poll_id = ? AND hidden = 0
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(pollId).all();
  return ((results || []) as PollOptionRow[]).map(toPublic);
}

/** All options (visible + hidden), for moderation views. */
export async function listAllOptions(db: D1Database, pollId: string): Promise<PollOption[]> {
  const { results } = await db.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options
     WHERE poll_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(pollId).all();
  return ((results || []) as PollOptionRow[]).map(toPublic);
}

async function countVisibleOptions(db: D1Database, pollId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as c FROM poll_options WHERE poll_id = ? AND hidden = 0`,
  ).bind(pollId).first() as { c: number } | null;
  return row?.c ?? 0;
}

/** poll_options.created_by_fid is a person key (account-root §5). */
async function countUserWriteins(db: D1Database, pollId: string, userKey: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as c FROM poll_options
     WHERE poll_id = ? AND created_by_fid = ? AND source = 'writein'`,
  ).bind(pollId, userKey).first() as { c: number } | null;
  return row?.c ?? 0;
}

/**
 * Seed a new open wave's declared options. Insertion order is preserved (rowid),
 * and all seeds share the wave's creation timestamp so they sort before any
 * future write-in. Duplicate normalized labels are de-duped (the creator may
 * have typed the same option twice).
 */
export async function seedOptions(
  db: D1Database,
  pollId: string,
  labels: string[],
  createdAtIso: string,
  createdByFid: number | null,
): Promise<void> {
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmts: any[] = [];
  for (const raw of labels) {
    const label = (raw ?? '').toString().trim().slice(0, MAX_LABEL_LEN);
    if (!label) continue;
    const norm = normalizeLabel(label);
    if (seen.has(norm)) continue;
    seen.add(norm);
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO poll_options
           (id, poll_id, label, label_norm, source, created_by_fid, created_at, hidden)
         VALUES (?, ?, ?, ?, 'seed', ?, ?, 0)`,
      ).bind(crypto.randomUUID(), pollId, label, norm, createdByFid, createdAtIso),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * Record an MC vote (append-only; latest per user wins). Mirrors the snap MC
 * write path exactly so counts stay consistent across surfaces. pub_answers is
 * incremented only on the user's first MC answer for this question.
 * `pollId` stamps the wave the vote was cast through (NULL = direct answer).
 * `userKey` is the voter's person key (fid before the account cutover, account
 * id after); callers holding a Farcaster fid map it with `userKeyForFid`.
 */
export async function recordMcVote(
  env: Env,
  qId: string,
  userKey: number,
  value: string,
  audience: 'Public' | 'Anon' = 'Public',
  pollId: string | null = null,
): Promise<void> {
  const answerId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const privacyTier = audience === 'Anon' ? 'anon' : 'public';

  // Tags over the person key (plus its legacy key during the cutover window).
  const tag = (await anonTagReady(env)) ? await authorTags(env, userKey, qId) : null;
  const existing = await getExistingAnswer(env.DB, qId, userKey, 2, undefined, tag);
  // An Anon row carries the placeholder; the sealed attribution lands in the same batch.
  const anon = await anonWriteFor(env, { fid: userKey, audience, answerId, qId, createdAt: nowIso });
  // answer_meta.responder_fid is a Farcaster fact: the placeholder fid on an
  // Anon row (as before), else the voter's linked fid (NULL without one).
  // Before the cutover this is exactly anon.rowFid.
  const responderFid = anon.statement ? anonPlaceholderFid(env) : ((await farcasterFidOf(env, userKey)) ?? null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batch: any[] = [
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
       VALUES (?, ?, ?, ?, 2, ?, ?, ?)`,
    ).bind(answerId, qId, anon.rowFid, value, audience, nowIso, pollId),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).bind(answerId, qId, responderFid, privacyTier, value, nowMs),
    ...(anon.statement ? [anon.statement] : []),
  ];
  if (!existing) {
    batch.push(
      env.DB.prepare(`UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`).bind(qId),
    );
  }
  await env.DB.batch(batch);
}

export type WriteInResult =
  | { ok: true; option: PollOption; merged: boolean }
  | { ok: false; status: number; error: string };

/**
 * Add a write-in option to a wave (or merge into an existing one) AND record
 * the submitter's vote for it. Enforces the wave's open flag, cap, per-user
 * write-in limit, normalized dedup, and the 60-char label cap. Returns the
 * option row (newly created or merged-into) on success.
 *
 * The caller must have ensured the user exists (FK on Answers.user_id) and
 * passed the wave's eligibility gate. `userKey` is the person key (as for
 * recordMcVote); it is also what poll_options.created_by_fid records.
 */
export async function addOrVoteWriteIn(
  env: Env,
  poll: Pick<PollRow, 'id' | 'question_id' | 'options_config'>,
  userKey: number,
  rawLabel: string,
  audience: 'Public' | 'Anon' = 'Public',
): Promise<WriteInResult> {
  const label = (rawLabel ?? '').toString().trim();
  if (!label) return { ok: false, status: 400, error: 'Empty option' };
  if (label.length > MAX_LABEL_LEN) {
    return { ok: false, status: 400, error: `Option too long (max ${MAX_LABEL_LEN} chars)` };
  }
  const norm = normalizeLabel(label);

  const cfg = parseOptionsConfig(poll.options_config);
  if (!cfg) return { ok: false, status: 400, error: 'Not an open poll' };
  const qId = poll.question_id;
  const pollId = poll.id;

  // Dedup: a normalized match merges the vote onto the existing option.
  const existing = await env.DB.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options WHERE poll_id = ? AND label_norm = ?`,
  ).bind(pollId, norm).first() as PollOptionRow | null;
  if (existing) {
    if (existing.hidden) return { ok: false, status: 403, error: 'That option was removed' };
    await recordMcVote(env, qId, userKey, existing.label, audience, pollId);
    return { ok: true, merged: true, option: toPublic(existing) };
  }

  // New option — enforce cap and per-user write-in limit.
  if (await countVisibleOptions(env.DB, pollId) >= cfg.cap) {
    return { ok: false, status: 409, error: 'This poll has reached its option limit' };
  }
  if (cfg.writeins_per_user > 0 && (await countUserWriteins(env.DB, pollId, userKey)) >= cfg.writeins_per_user) {
    return { ok: false, status: 403, error: 'You have already added an option to this poll' };
  }

  const optId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO poll_options
         (id, poll_id, label, label_norm, source, created_by_fid, created_at, hidden)
       VALUES (?, ?, ?, ?, 'writein', ?, ?, 0)`,
    ).bind(optId, pollId, label, norm, userKey, nowIso).run();
  } catch {
    // UNIQUE(poll_id, label_norm) race: a concurrent write-in inserted the same
    // normalized label first. Merge the vote onto the winner.
    const winner = await env.DB.prepare(
      `SELECT ${OPTION_COLS} FROM poll_options WHERE poll_id = ? AND label_norm = ?`,
    ).bind(pollId, norm).first() as PollOptionRow | null;
    if (winner && !winner.hidden) {
      await recordMcVote(env, qId, userKey, winner.label, audience, pollId);
      return { ok: true, merged: true, option: toPublic(winner) };
    }
    return { ok: false, status: 409, error: 'Could not add option' };
  }

  await recordMcVote(env, qId, userKey, label, audience, pollId);
  return {
    ok: true,
    merged: false,
    option: {
      id: optId,
      label,
      source: 'writein',
      created_at: nowIso,
      hidden: false,
    },
  };
}

/** Hide / unhide an option (moderation). Returns true if a row was updated. */
export async function setOptionHidden(
  db: D1Database,
  pollId: string,
  optionId: string,
  hidden: boolean,
): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE poll_options SET hidden = ? WHERE poll_id = ? AND id = ?`,
  ).bind(hidden ? 1 : 0, pollId, optionId).run();
  return (res?.meta?.changes ?? 0) > 0;
}
