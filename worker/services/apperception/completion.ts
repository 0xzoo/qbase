// apperception — quiz_completions row writer.
//
// Apperception's per-FID session lives in KV (see session.ts), but for the
// /quizzes feed and any future cross-quiz analytics we want a row in the
// shared `quiz_completions` table the same way values + bartlet do it.
//
// Two call sites use this:
//   1. worker/routes/apperception.ts     — snap completion event
//   2. worker/routes/apperception-api.ts — web (browser) completion event
//
// `createQuizCompletion` blindly INSERTs; each call site guards with
// `hasApperceptionCompletion` first so a stray replay (or a re-take by an
// FID with a prior row) doesn't create duplicates. The dedup is at the
// call site, not in the writer, because the live-completion edges are
// already one-shot (session.index can only cross the threshold once per
// session) and the explicit pre-SELECT documents that invariant.

import { freeTierResult, type ApperceptionAnswer } from './scoring';
import { createQuizCompletion } from '../../routes/quiz-completions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Persist a quiz_completions row for a completed apperception session.
 * Best-effort: throws are swallowed at the call site so a quiz_completions
 * write hiccup never blocks the result snap / page.
 *
 * `resultCategory` is the free-tier dominant style (e.g. "BUILDER") — same
 * label the snap result scene shows, so the /quizzes feed can echo it
 * verbatim.
 */
export async function writeApperceptionCompletion(
  env: Env,
  args: { fid: number; answers: ApperceptionAnswer[] },
): Promise<string> {
  const result = freeTierResult(args.answers);
  return createQuizCompletion(env, {
    quizId: 'apperception',
    userId: args.fid,
    answersJson: JSON.stringify(args.answers),
    scores: {
      concrete: result.scores.concrete,
      reflective: result.scores.reflective,
      sequential: result.scores.sequential,
      confidence: result.scores.confidence,
      style: result.style.style,
      blended: result.style.blended,
      confidenceBand: result.style.confidence,
    },
    resultCategory: result.style.style,
  });
}

/**
 * Has this FID already got an apperception completion row? Used by the
 * backfill to skip rows it's already written, and by the snap/web live paths
 * to avoid double-inserting on a hypothetical replay (e.g. a retried POST
 * after the session had already advanced past the threshold).
 */
export async function hasApperceptionCompletion(
  env: Env,
  fid: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM quiz_completions WHERE quiz_id = 'apperception' AND user_id = ? LIMIT 1",
  ).bind(fid).first();
  return !!row;
}
