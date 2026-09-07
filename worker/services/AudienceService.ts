/**
 * AudienceService — a person's audience is sticky within a wave.
 *
 * Append-only latest-wins means a re-answer replaces the earlier one in the
 * tally. If the earlier answer was anon and the new one public (or the
 * reverse), the tally moves at the exact moment a named vote appears, which
 * links the anon vote to the person. So the first tallied answer a person
 * gives in a wave (or directly to a question) decides their audience there:
 * later answers keep it regardless of the toggle. Private / Allowlist
 * answers are outside the tally and outside this rule.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export type TalliedAudience = 'Public' | 'Anon';

/** Anything that isn't exactly 'Anon' is a public tallied vote. */
export function coerceTalliedAudience(raw: unknown): TalliedAudience {
  return raw === 'Anon' ? 'Anon' : 'Public';
}

export interface StickyAudience {
  audience: TalliedAudience;
  /** True when an earlier answer decided it (the request may have differed). */
  sticky: boolean;
}

/**
 * The audience this person's answer must carry in this wave (`pollId`) or,
 * for direct answers, on this question. The earliest tallied row wins.
 */
export async function resolveStickyAudience(
  db: D1Database,
  questionId: string,
  userId: number,
  pollId: string | null,
  requested: TalliedAudience,
): Promise<StickyAudience> {
  const scope = pollId ? 'AND poll_id = ?' : 'AND poll_id IS NULL';
  const binds = pollId ? [questionId, userId, pollId] : [questionId, userId];
  const first = await db.prepare(`
    SELECT audience FROM Answers
    WHERE q_id = ? AND user_id = ? AND audience IN ('Public', 'Anon') ${scope}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).bind(...binds).first() as { audience: string } | null;
  if (!first) return { audience: requested, sticky: false };
  return { audience: coerceTalliedAudience(first.audience), sticky: true };
}
