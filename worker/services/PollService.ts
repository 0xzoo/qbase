/**
 * PollService — reads and writes for the `polls` table (waves).
 *
 * A poll is a time-gated wave over a durable question (migration 0064,
 * docs/specs/question-wave-attribution.md). The question is always
 * answerable; gates (`closes_at`, `eligibility_gate`) live on the wave only.
 * Answers cast through a wave carry `Answers.poll_id`; direct answers carry
 * NULL.
 *
 * `getCurrentPoll` is the interim resolver for surfaces that do not yet carry
 * a poll id (the snap URL until Track A4): the most recently opened wave on
 * the question, open or closed. Once the URL carries the id, callers should
 * use `getPoll` and treat a missing id as "the question itself".
 */

export interface PollRow {
  id: string;
  question_id: string;
  /** ISO 8601. NOT NULL — the time gate is what makes a wave a wave. */
  closes_at: string;
  /** JSON (EligibilityGate) or NULL. */
  eligibility_gate: string | null;
  /** JSON (OptionsConfig) or NULL. */
  options_config: string | null;
  author_fid: number | null;
  cast_hash: string | null;
  created_at: string;
}

export interface NewPoll {
  question_id: string;
  closes_at: string;
  eligibility_gate?: string | null;
  options_config?: string | null;
  author_fid?: number | null;
  cast_hash?: string | null;
  /** Defaults to a fresh UUID. */
  id?: string;
  /** Defaults to now. */
  created_at?: string;
}

const POLL_COLS =
  'id, question_id, closes_at, eligibility_gate, options_config, author_fid, cast_hash, created_at';

export async function getPoll(db: D1Database, pollId: string): Promise<PollRow | null> {
  const row = await db
    .prepare(`SELECT ${POLL_COLS} FROM polls WHERE id = ? LIMIT 1`)
    .bind(pollId)
    .first();
  return (row as PollRow | null) ?? null;
}

/**
 * The wave a poll-less surface resolves to: the most recently opened wave on
 * the question (closed waves included — a closed wave still owns its cast).
 * NULL when the question has never had a wave.
 */
export async function getCurrentPoll(db: D1Database, questionId: string): Promise<PollRow | null> {
  const row = await db
    .prepare(
      `SELECT ${POLL_COLS} FROM polls
       WHERE question_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .bind(questionId)
    .first();
  return (row as PollRow | null) ?? null;
}

export async function insertPoll(db: D1Database, poll: NewPoll): Promise<PollRow> {
  const row: PollRow = {
    id: poll.id ?? crypto.randomUUID(),
    question_id: poll.question_id,
    closes_at: poll.closes_at,
    eligibility_gate: poll.eligibility_gate ?? null,
    options_config: poll.options_config ?? null,
    author_fid: poll.author_fid ?? null,
    cast_hash: poll.cast_hash ?? null,
    created_at: poll.created_at ?? new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO polls (${POLL_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.question_id,
      row.closes_at,
      row.eligibility_gate,
      row.options_config,
      row.author_fid,
      row.cast_hash,
      row.created_at,
    )
    .run();
  return row;
}

/** True once the wave's close time has passed. Unparseable closes_at → open. */
export function isPollClosed(poll: Pick<PollRow, 'closes_at'>, nowMs: number = Date.now()): boolean {
  const closesMs = Date.parse(poll.closes_at);
  return Number.isFinite(closesMs) && closesMs <= nowMs;
}
