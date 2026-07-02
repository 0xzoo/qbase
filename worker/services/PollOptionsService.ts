/**
 * PollOptionsService — open-options polls (write-in multiple choice).
 *
 * An open poll (queries.options_config.open) keeps its option set open: a
 * respondent can vote an existing option or write in a new one, which becomes
 * a first-class, votable option stored as a `poll_options` row. The write-in
 * also records the submitter's vote in the SAME append-only Answers/answer_meta
 * path as a normal MC vote, so counting (AnswerCountService.getMcCounts) needs
 * no special-casing — it already groups by the answer's `value`.
 *
 * Callers MUST have ensured the voting user exists (FK on Answers.user_id)
 * before invoking recordMcVote / addOrVoteWriteIn.
 *
 * See docs/plans/open-options-poll.md.
 */

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
  q_id: string;
  label: string;
  label_norm: string;
  source: string;
  created_by_fid: number | null;
  created_at: string;
  hidden: number;
}

/**
 * Parse queries.options_config. Returns null for a classic (closed) MC question
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
  'id, q_id, label, label_norm, source, created_by_fid, created_at, hidden';

/** Visible options for a poll, in declared order (seeds first, then write-ins by time). */
export async function listVisibleOptions(db: D1Database, qId: string): Promise<PollOption[]> {
  const { results } = await db.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options
     WHERE q_id = ? AND hidden = 0
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(qId).all();
  return ((results || []) as PollOptionRow[]).map(toPublic);
}

/** All options (visible + hidden), for moderation views. */
export async function listAllOptions(db: D1Database, qId: string): Promise<PollOption[]> {
  const { results } = await db.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options
     WHERE q_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(qId).all();
  return ((results || []) as PollOptionRow[]).map(toPublic);
}

async function countVisibleOptions(db: D1Database, qId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as c FROM poll_options WHERE q_id = ? AND hidden = 0`,
  ).bind(qId).first() as { c: number } | null;
  return row?.c ?? 0;
}

async function countUserWriteins(db: D1Database, qId: string, fid: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as c FROM poll_options
     WHERE q_id = ? AND created_by_fid = ? AND source = 'writein'`,
  ).bind(qId, fid).first() as { c: number } | null;
  return row?.c ?? 0;
}

/**
 * Seed a new open poll's declared options. Insertion order is preserved (rowid),
 * and all seeds share the question's creation timestamp so they sort before any
 * future write-in. Duplicate normalized labels are de-duped (the creator may
 * have typed the same option twice).
 */
export async function seedOptions(
  db: D1Database,
  qId: string,
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
           (id, q_id, label, label_norm, source, created_by_fid, created_at, hidden)
         VALUES (?, ?, ?, ?, 'seed', ?, ?, 0)`,
      ).bind(crypto.randomUUID(), qId, label, norm, createdByFid, createdAtIso),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * Record an MC vote (append-only; latest per user wins). Mirrors the snap MC
 * write path exactly so counts stay consistent across surfaces. pub_answers is
 * incremented only on the user's first MC answer for this question.
 */
export async function recordMcVote(
  env: Env,
  qId: string,
  fid: number,
  value: string,
  audience: 'Public' | 'Anon' = 'Public',
): Promise<void> {
  const answerId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const privacyTier = audience === 'Anon' ? 'anon' : 'public';

  const existing = await env.DB.prepare(
    `SELECT a.id FROM Answers a
     WHERE a.q_id = ? AND a.user_id = ? AND a.answer_type_id = 2`,
  ).bind(qId, fid).first();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batch: any[] = [
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at)
       VALUES (?, ?, ?, ?, 2, ?, ?)`,
    ).bind(answerId, qId, fid, value, audience, nowIso),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).bind(answerId, qId, fid, privacyTier, value, nowMs),
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
 * Add a write-in option (or merge into an existing one) AND record the
 * submitter's vote for it. Enforces the open flag, cap, per-user write-in
 * limit, normalized dedup, and the 60-char label cap. Returns the option row
 * (newly created or merged-into) on success.
 *
 * The caller must have ensured the user exists (FK on Answers.user_id).
 */
export async function addOrVoteWriteIn(
  env: Env,
  qId: string,
  fid: number,
  rawLabel: string,
  audience: 'Public' | 'Anon' = 'Public',
): Promise<WriteInResult> {
  const label = (rawLabel ?? '').toString().trim();
  if (!label) return { ok: false, status: 400, error: 'Empty option' };
  if (label.length > MAX_LABEL_LEN) {
    return { ok: false, status: 400, error: `Option too long (max ${MAX_LABEL_LEN} chars)` };
  }
  const norm = normalizeLabel(label);

  const q = await env.DB.prepare(`SELECT options_config FROM queries WHERE id = ?`)
    .bind(qId).first() as { options_config: string | null } | null;
  if (!q) return { ok: false, status: 404, error: 'Question not found' };
  const cfg = parseOptionsConfig(q.options_config);
  if (!cfg) return { ok: false, status: 400, error: 'Not an open poll' };

  // Dedup: a normalized match merges the vote onto the existing option.
  const existing = await env.DB.prepare(
    `SELECT ${OPTION_COLS} FROM poll_options WHERE q_id = ? AND label_norm = ?`,
  ).bind(qId, norm).first() as PollOptionRow | null;
  if (existing) {
    if (existing.hidden) return { ok: false, status: 403, error: 'That option was removed' };
    await recordMcVote(env, qId, fid, existing.label, audience);
    return { ok: true, merged: true, option: toPublic(existing) };
  }

  // New option — enforce cap and per-user write-in limit.
  if (await countVisibleOptions(env.DB, qId) >= cfg.cap) {
    return { ok: false, status: 409, error: 'This poll has reached its option limit' };
  }
  if (cfg.writeins_per_user > 0 && (await countUserWriteins(env.DB, qId, fid)) >= cfg.writeins_per_user) {
    return { ok: false, status: 403, error: 'You have already added an option to this poll' };
  }

  const optId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO poll_options
         (id, q_id, label, label_norm, source, created_by_fid, created_at, hidden)
       VALUES (?, ?, ?, ?, 'writein', ?, ?, 0)`,
    ).bind(optId, qId, label, norm, fid, nowIso).run();
  } catch {
    // UNIQUE(q_id, label_norm) race: a concurrent write-in inserted the same
    // normalized label first. Merge the vote onto the winner.
    const winner = await env.DB.prepare(
      `SELECT ${OPTION_COLS} FROM poll_options WHERE q_id = ? AND label_norm = ?`,
    ).bind(qId, norm).first() as PollOptionRow | null;
    if (winner && !winner.hidden) {
      await recordMcVote(env, qId, fid, winner.label, audience);
      return { ok: true, merged: true, option: toPublic(winner) };
    }
    return { ok: false, status: 409, error: 'Could not add option' };
  }

  await recordMcVote(env, qId, fid, label, audience);
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
  qId: string,
  optionId: string,
  hidden: boolean,
): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE poll_options SET hidden = ? WHERE id = ? AND q_id = ?`,
  ).bind(hidden ? 1 : 0, optionId, qId).run();
  return (res?.meta?.changes ?? 0) > 0;
}
