/**
 * AnswerCountService — shared answer counting for append-only answer types.
/**
 * MC, Checkbox, and Scale answers are append-only: old answers are preserved for
 * time-series analysis. The "current" answer per user is the latest by
 * created_at DESC. Count queries use a CTE with ROW_NUMBER to only count
 * the latest per user.
 *
 * MC: one vote per user (latest wins). Counts grouped by option label.
 * Checkbox: one submission per user (latest wins). Per-option counts derived
 *   from comma-separated value field (each row = a snapshot of selected options).
 * Scale: one value per user (latest wins). Returns unique responder count only
 *   (no per-option breakdown — scale values are continuous, not categorical).
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

/**
 * Get MC vote counts for a question, counting only each user's latest answer.
 * Used by: loadSnapCounts, GET /api/answers/results/:id
 *
 * @param db D1Database
 * @param questionId The question ID
 * @returns { counts: { optionLabel: count }, total: uniqueResponderCount }
 */
export async function getMcCounts(
  db: D1Database,
  questionId: string,
): Promise<OptionCountResult> {
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 2 AND audience IN ('Public', 'Anon')
    )
    SELECT value, COUNT(*) as count
    FROM latest_per_user WHERE rn = 1
    GROUP BY value
  `).bind(questionId).all();

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
 * Each user's latest answer (comma-separated selections) is split into individual
 * options and counted.
 *
 * @param db D1Database
 * @param questionId The question ID
 * @returns { optionCounts: { optionLabel: count }, total: uniqueResponderCount }
 */
export async function getCheckboxCounts(
  db: D1Database,
  questionId: string,
): Promise<CheckboxOptionCountResult> {
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 4 AND audience = 'Public'
    )
    SELECT value FROM latest_per_user WHERE rn = 1
  `).bind(questionId).all();

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
 * No per-option breakdown — scale values are continuous, not categorical.
 *
 * @param db D1Database
 * @param questionId The question ID
 * @returns total: uniqueResponderCount
 */
export async function getScaleCounts(
  db: D1Database,
  questionId: string,
): Promise<{ total: number }> {
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 3 AND audience = 'Public'
    )
    SELECT COUNT(*) as total FROM latest_per_user WHERE rn = 1
  `).bind(questionId).all();

  const total = (results?.[0] as { total: number })?.total ?? 0;
  return { total };
}

/**
 * Check if a user already has an answer of a given type for a question.
 * Returns the existing answer row if found, null otherwise.
 */
export async function getExistingAnswer(
  db: D1Database,
  questionId: string,
  userId: number,
  answerTypeId: number,
): Promise<{ id: string } | null> {
  return db.prepare(`
    SELECT a.id FROM Answers a
    WHERE a.q_id = ? AND a.user_id = ? AND a.answer_type_id = ?
  `).bind(questionId, userId, answerTypeId).first() as Promise<{ id: string } | null>;
}
