/**
 * AnswerCountService — shared answer counting for append-only answer types.
 *
 * MC, Checkbox, and Scale answers are append-only: old answers are preserved for
 * time-series analysis. The "current" answer per user is the latest by
 * created_at DESC. Count queries use a CTE with ROW_NUMBER to only count
 * the latest per user.
 *
 * MC: one answer per user (latest wins). Counts grouped by option label.
 * Checkbox: one submission per user (latest wins). Per-option counts derived
 *   from comma-separated value field (each row = a snapshot of selected options).
 * Scale: one value per user (latest wins). Returns unique responder count only
 *   (no per-option breakdown — scale values are continuous, not categorical).
 *
 * Wave scope: every reader takes an optional `pollId`. With it, only answers
 * attributed to that wave (`Answers.poll_id = ?`) are considered and "latest
 * per user" becomes "latest per (wave, user)". Without it, the question-level
 * view counts every answer regardless of wave (direct answers included).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

interface OptionCountResult {
  counts: Record<string, number>;
  total: number;
}

interface CheckboxOptionCountResult {
  optionCounts: Record<string, number>;
  total: number;
}

/** SQL fragment + binding for the optional wave filter. */
function pollScope(pollId?: string | null): { sql: string; binds: string[] } {
  return pollId ? { sql: ' AND poll_id = ?', binds: [pollId] } : { sql: '', binds: [] };
}

/**
 * Get MC answer counts for a question (or one wave of it), counting only
 * each user's latest answer. Used by: loadSnapCounts, GET /api/answers/results/:id
 *
 * @returns { counts: { optionLabel: count }, total: uniqueResponderCount }
 */
export async function getMcCounts(
  db: D1Database,
  questionId: string,
  pollId?: string | null,
): Promise<OptionCountResult> {
  const scope = pollScope(pollId);
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 2 AND audience IN ('Public', 'Anon')${scope.sql}
    )
    SELECT value, COUNT(*) as count
    FROM latest_per_user WHERE rn = 1
    GROUP BY value
  `).bind(questionId, ...scope.binds).all();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of (results || []) as Array<{ value: string; count: number }>) {
    counts[row.value] = row.count;
    total += row.count;
  }
  return { counts, total };
}

/**
 * Get checkbox per-option counts, counting only each user's latest submission.
 * Public and Anon rows count, as for MC (Zoo, 2026-09-08: Likert and checkbox
 * were Public-only, so an Anon answer counted nowhere).
 * Each user's latest answer (comma-separated selections) is split into individual
 * options and counted.
 *
 * @returns { optionCounts: { optionLabel: count }, total: uniqueResponderCount }
 */
export async function getCheckboxCounts(
  db: D1Database,
  questionId: string,
  pollId?: string | null,
): Promise<CheckboxOptionCountResult> {
  const scope = pollScope(pollId);
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 4 AND audience IN ('Public', 'Anon')${scope.sql}
    )
    SELECT value FROM latest_per_user WHERE rn = 1
  `).bind(questionId, ...scope.binds).all();

  const optionCounts: Record<string, number> = {};
  let total = 0;
  for (const row of (results || []) as Array<{ value: string }>) {
    total++;
    const parts = row.value.split(',').map(s => s.trim());
    for (const p of parts) {
      if (p) optionCounts[p] = (optionCounts[p] ?? 0) + 1;
    }
  }
  return { optionCounts, total };
}

/**
 * Get unique responder count for scale questions, counting only each user's latest answer.
 * Public and Anon rows count, as for MC.
 * No per-option breakdown — scale values are continuous, not categorical.
 *
 * @returns total: uniqueResponderCount
 */
export async function getScaleCounts(
  db: D1Database,
  questionId: string,
  pollId?: string | null,
): Promise<{ total: number }> {
  const scope = pollScope(pollId);
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 3 AND audience IN ('Public', 'Anon')${scope.sql}
    )
    SELECT COUNT(*) as total FROM latest_per_user WHERE rn = 1
  `).bind(questionId, ...scope.binds).all();

  const total = (results?.[0] as { total: number })?.total ?? 0;
  return { total };
}

/**
 * Check if a user already has an answer of a given type for a question (or
 * one wave of it). Returns the existing answer row if found (latest by
 * created_at), null otherwise.
 */
export async function getExistingAnswer(
  db: D1Database,
  questionId: string,
  userId: number,
  answerTypeId: number,
  pollId?: string | null,
): Promise<{ id: string; value: string | null; answer_data: string | null } | null> {
  const scope = pollScope(pollId);
  // answer_type_id column is TEXT — bind as string so D1's INTEGER
  // parameter binding doesn't break the comparison against '2'/'3'/'4'.
  return db.prepare(`
    SELECT a.id, a.value, a.answer_data FROM Answers a
    WHERE a.q_id = ? AND a.user_id = ? AND a.answer_type_id = ?${scope.sql}
    ORDER BY a.created_at DESC
    LIMIT 1
  `).bind(questionId, userId, String(answerTypeId), ...scope.binds).first() as Promise<
    { id: string; value: string | null; answer_data: string | null } | null
  >;
}

export interface VoteChurn {
  /** Responders whose latest answer differs from an earlier one in this wave. */
  changed_voters: number;
  /** Total re-answers (rows beyond each responder's first). */
  total_changes: number;
}

export interface VoteChange {
  fid: number;
  from: string;
  to: string;
  at: string;
}

/**
 * Vote-change signal for one wave (append-only latest-wins makes it
 * observable). Churn counts every identifiable responder, public or anon;
 * the per-change log is public votes only — anon churn stays aggregate.
 * `sharedAnonIds` rows are excluded from churn: anon answers stored under a
 * shared user_id (the anon user / the @4n0n bot) are different people, so
 * their "changes" are not flips.
 */
export async function getVoteChurn(
  db: D1Database,
  pollId: string,
  answerTypeId: number,
  sharedAnonIds: number[],
): Promise<{ churn: VoteChurn; changes: VoteChange[] }> {
  const excluded = sharedAnonIds.length ? sharedAnonIds : [-1];
  const placeholders = excluded.map(() => '?').join(', ');
  const churnRow = await db.prepare(`
    WITH per_user AS (
      SELECT user_id, COUNT(*) AS c FROM Answers
      WHERE poll_id = ? AND answer_type_id = ? AND audience IN ('Public', 'Anon')
        AND user_id NOT IN (${placeholders})
      GROUP BY user_id
    )
    SELECT
      COALESCE(SUM(CASE WHEN c > 1 THEN 1 ELSE 0 END), 0) AS changed_voters,
      COALESCE(SUM(c - 1), 0) AS total_changes
    FROM per_user
  `).bind(pollId, String(answerTypeId), ...excluded).first() as { changed_voters: number; total_changes: number } | null;

  const { results } = await db.prepare(`
    WITH ordered AS (
      SELECT user_id, value, created_at,
        LAG(value) OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) AS prev
      FROM Answers
      WHERE poll_id = ? AND answer_type_id = ? AND audience = 'Public'
    )
    SELECT user_id AS fid, prev AS from_value, value AS to_value, created_at AS at
    FROM ordered
    WHERE prev IS NOT NULL AND prev != value
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(pollId, String(answerTypeId)).all();

  const changes = ((results || []) as Array<{ fid: number; from_value: string; to_value: string; at: string }>)
    .map(r => ({ fid: r.fid, from: r.from_value, to: r.to_value, at: r.at }));

  return {
    churn: {
      changed_voters: churnRow?.changed_voters ?? 0,
      total_changes: churnRow?.total_changes ?? 0,
    },
    changes,
  };
}
