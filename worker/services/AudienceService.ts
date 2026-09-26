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

import { ownRowsDualSql, ownRowsBinds } from './AnonAttributionService';

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
 * `userId` is the person key (fid before the account cutover, account id
 * after). `authorTag` is `authorTags(env, userId, questionId)` (or a single
 * `anonTag`): an Anon row carries the placeholder in `user_id`, so it is the
 * person's only through the tag — during the cutover window through either
 * the account's tag or its legacy one.
 */
export async function resolveStickyAudience(
  db: D1Database,
  questionId: string,
  userId: number,
  pollId: string | null,
  requested: TalliedAudience,
  authorTag: string | readonly string[] | null = null,
): Promise<StickyAudience> {
  const scope = pollId ? 'AND a.poll_id = ?' : 'AND a.poll_id IS NULL';
  const own = ownRowsBinds(userId, authorTag);
  const binds = pollId ? [questionId, ...own, pollId] : [questionId, ...own];
  const first = await db.prepare(`
    SELECT a.audience FROM Answers a
    WHERE a.q_id = ? AND ${ownRowsDualSql('a')} AND a.audience IN ('Public', 'Anon') ${scope}
    ORDER BY a.created_at ASC, a.id ASC
    LIMIT 1
  `).bind(...binds).first() as { audience: string } | null;
  if (!first) return { audience: requested, sticky: false };
  return { audience: coerceTalliedAudience(first.audience), sticky: true };
}
