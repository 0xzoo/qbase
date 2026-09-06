/**
 * PollService — reads and writes for the `polls` table (waves).
 *
 * A poll is a time-gated wave over a durable question (migration 0064,
 * docs/specs/question-wave-attribution.md). The question is always
 * answerable; gates (`closes_at`, `eligibility_gate`), open-options config
 * and provenance (`author_fid`, `cast_hash`, `channel_id`) live on the wave.
 * Answers cast through a wave carry `Answers.poll_id`; direct answers carry
 * NULL. Opening a wave (validation, snapshot reuse, seeding) is
 * WaveService.openWave; this module is the row layer.
 *
 * Two resolvers for surfaces that only know the question:
 *   - getOpenPoll     — the most recently opened wave that is still accepting
 *                       answers, or null. The question snap/page answers
 *                       through it while it is live.
 *   - getCurrentPoll  — the most recently opened wave, open or closed.
 */

import type { EligibilityGate, PublicEligibilityGate } from '../../src/lib/types';
import { parseOptionsConfig, type OptionsConfig } from './PollOptionsService';

export type PollKind = 'measure' | 'decide';

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
  channel_id: string | null;
  kind: PollKind;
  created_at: string;
}

export interface NewPoll {
  question_id: string;
  closes_at: string;
  eligibility_gate?: string | null;
  options_config?: string | null;
  author_fid?: number | null;
  cast_hash?: string | null;
  channel_id?: string | null;
  kind?: PollKind;
  /** Defaults to a fresh UUID. */
  id?: string;
  /** Defaults to now. */
  created_at?: string;
}

/** Wire shape: the gate never ships its FID list; JSON columns are parsed. */
export interface PublicPoll {
  id: string;
  question_id: string;
  closes_at: string;
  is_closed: boolean;
  kind: PollKind;
  eligibility_gate?: PublicEligibilityGate;
  options_config?: OptionsConfig;
  author_fid?: number;
  cast_hash?: string;
  channel_id?: string;
  created_at: string;
}

const POLL_COLS =
  'id, question_id, closes_at, eligibility_gate, options_config, author_fid, cast_hash, channel_id, kind, created_at';

export async function getPoll(db: D1Database, pollId: string): Promise<PollRow | null> {
  const row = await db
    .prepare(`SELECT ${POLL_COLS} FROM polls WHERE id = ? LIMIT 1`)
    .bind(pollId)
    .first();
  return (row as PollRow | null) ?? null;
}

/**
 * The most recently opened wave on the question, closed waves included.
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

/**
 * The most recently opened wave that is still accepting answers, or NULL.
 * This is what a poll-less surface (question snap, question page) answers
 * through while a wave is live; once it closes the question is itself again.
 */
export async function getOpenPoll(
  db: D1Database,
  questionId: string,
  nowIso: string = new Date().toISOString(),
): Promise<PollRow | null> {
  const row = await db
    .prepare(
      `SELECT ${POLL_COLS} FROM polls
       WHERE question_id = ? AND closes_at > ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .bind(questionId, nowIso)
    .first();
  return (row as PollRow | null) ?? null;
}

/** Every wave on a question, newest first. */
export async function listPollsForQuestion(db: D1Database, questionId: string): Promise<PollRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${POLL_COLS} FROM polls
       WHERE question_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(questionId)
    .all();
  return ((results || []) as unknown) as PollRow[];
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
    channel_id: poll.channel_id ?? null,
    kind: poll.kind ?? 'measure',
    created_at: poll.created_at ?? new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO polls (${POLL_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.question_id,
      row.closes_at,
      row.eligibility_gate,
      row.options_config,
      row.author_fid,
      row.cast_hash,
      row.channel_id,
      row.kind,
      row.created_at,
    )
    .run();
  return row;
}

/** Record the cast that launched a wave (provenance). */
export async function setPollCastHash(db: D1Database, pollId: string, castHash: string): Promise<void> {
  await db.prepare('UPDATE polls SET cast_hash = ? WHERE id = ? AND cast_hash IS NULL')
    .bind(castHash, pollId).run();
}

/** True once the wave's close time has passed. Unparseable closes_at → open. */
export function isPollClosed(poll: Pick<PollRow, 'closes_at'>, nowMs: number = Date.now()): boolean {
  const closesMs = Date.parse(poll.closes_at);
  return Number.isFinite(closesMs) && closesMs <= nowMs;
}

export function parsePollGate(raw: string | null | undefined): EligibilityGate | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EligibilityGate;
  } catch {
    return null;
  }
}

/** Strip the FID list (never shipped to the wire) and parse JSON columns. */
export function toPublicPoll(row: PollRow, nowMs: number = Date.now()): PublicPoll {
  const out: PublicPoll = {
    id: row.id,
    question_id: row.question_id,
    closes_at: row.closes_at,
    is_closed: isPollClosed(row, nowMs),
    kind: row.kind ?? 'measure',
    created_at: row.created_at,
  };
  const gate = parsePollGate(row.eligibility_gate);
  if (gate) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { snapshot_fids: _fids, ...rest } = gate;
    out.eligibility_gate = rest as PublicEligibilityGate;
  }
  const cfg = parseOptionsConfig(row.options_config);
  if (cfg) out.options_config = cfg;
  if (row.author_fid != null) out.author_fid = row.author_fid;
  if (row.cast_hash) out.cast_hash = row.cast_hash;
  if (row.channel_id) out.channel_id = row.channel_id;
  return out;
}
