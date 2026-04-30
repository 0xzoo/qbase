/**
 * McAnswerService — shared MC (multiple choice) answer counting.
 *
 * MC answers are append-only: old answers are preserved for time-series analysis.
 * The "current" answer per user is the latest by created_at DESC.
 * Count queries use a CTE with ROW_NUMBER to only count the latest per user.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

interface McCountResult {
  counts: Record<string, number>;
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
): Promise<McCountResult> {
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 2 AND audience = 'Public'
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
 * Check if a user already has an MC answer for a question.
 * Returns the existing answer row if found, null otherwise.
 */
export async function getExistingMcAnswer(
  db: D1Database,
  questionId: string,
  userId: number,
): Promise<{ id: string } | null> {
  return db.prepare(`
    SELECT a.id FROM Answers a
    WHERE a.q_id = ? AND a.user_id = ? AND a.answer_type_id = 2
    ORDER BY a.created_at DESC LIMIT 1
  `).bind(questionId, userId).first() as Promise<{ id: string } | null>;
}
