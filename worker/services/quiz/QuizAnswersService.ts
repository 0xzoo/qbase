/**
 * QuizAnswersService — quiz answers as first-class Answers rows
 * (docs/quizzes/CONTENT-PLAN.md §6 V1; card t_b544c849).
 *
 * `materializeCompletionAnswers` writes one Answers row per quiz item for a
 * completion, shaped exactly like a Private answer from POST /api/answers
 * (handlers/answers/create.ts): audience 'Private', value '[encrypted]', the
 * content {value, answer_data, reasoning: null} sealed under Q's key at
 * `answers/private/<id>` (SecretStore, same AAD), `storage_ref` pointing at
 * it, `poll_id` NULL (a direct answer to the canonical question), an
 * answer_meta row, and the question's priv_answers counter. New here:
 * `quiz_completion_id` names the completion. No points, no Vectorize entry,
 * no cast — quizzes are free and Private rows are never indexed.
 *
 * All-or-nothing per completion: the sealed objects go first, then every D1
 * statement (rows, meta, counters, the completion's `answers_materialized_at`)
 * in one batch; a failure on either side removes the objects already written.
 * If a canonical question row is missing for any item, nothing is written and
 * the completion stays unmarked, so the backfill (`backfill.ts`) picks it up
 * once the quiz's queries are registered (apperception's were not, as of
 * 2026-09-07). Re-scope of a materialised row is PUT /api/answers/:id, like
 * any other row.
 */

import { SecretStore } from '../secret/SecretStore';
import { sealedAnswerKey, stripAnswerDataContent } from '../../handlers/answers/shared';
import { canonicalize, type CanonicalAnswer, type SkipReason } from './canonicalAnswers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Env = any;

export interface MaterializeArgs {
  completionId: string;
  quizId: string;
  userId: number;
  answers: unknown[];
  /** ISO timestamp for the rows: now on the live path, `completed_at` on backfill. */
  createdAt: string;
}

export type SkipCounts = Partial<Record<SkipReason, number>>;

export interface MaterializePlan {
  items: CanonicalAnswer[];
  /** answers with no canonical mapping (unknown quiz or item, malformed, blank) */
  skipped: number;
  skipReasons: SkipCounts;
  /** canonical question ids absent from `queries` */
  missingQueries: string[];
  primaryType: Map<string, string>;
}

export interface MaterializeResult {
  /** true once the completion carries answers_materialized_at */
  materialized: boolean;
  written: number;
  skipped: number;
  skipReasons: SkipCounts;
  missingQueries: string[];
}

const PUT_CONCURRENCY = 4;
const AUDIENCE = 'Private';
const PRIVACY_TIER = 'private';
/** Quiz items are self-report; a question without a taxonomy counts as identity. */
const DEFAULT_PRIMARY_TYPE = 'identity';

/** Map the answers and check that every canonical question exists. Writes nothing. */
export async function planCompletionAnswers(env: Env, quizId: string, answers: unknown[]): Promise<MaterializePlan> {
  const items: CanonicalAnswer[] = [];
  let skipped = 0;
  const skipReasons: SkipCounts = {};
  for (const a of answers) {
    const o = canonicalize(quizId, a);
    if (o.answer) {
      items.push(o.answer);
    } else {
      skipped++;
      skipReasons[o.skip] = (skipReasons[o.skip] ?? 0) + 1;
    }
  }

  const primaryType = new Map<string, string>();
  const qIds = [...new Set(items.map((i) => i.qId))];
  if (qIds.length) {
    const rows = await env.DB.prepare(
      `SELECT id, json_extract(taxonomy, '$.primary_type') AS primary_type
       FROM queries WHERE id IN (${qIds.map(() => '?').join(',')})`,
    ).bind(...qIds).all();
    for (const r of (rows.results ?? []) as Array<{ id: string; primary_type: string | null }>) {
      primaryType.set(r.id, r.primary_type || DEFAULT_PRIMARY_TYPE);
    }
  }
  const missingQueries = qIds.filter((id) => !primaryType.has(id));
  return { items, skipped, skipReasons, missingQueries, primaryType };
}

async function runPool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      await fn(xs[i]);
    }
  });
  await Promise.all(workers);
}

export async function materializeCompletionAnswers(env: Env, args: MaterializeArgs): Promise<MaterializeResult> {
  const plan = await planCompletionAnswers(env, args.quizId, args.answers);
  const markDone = env.DB.prepare(
    'UPDATE quiz_completions SET answers_materialized_at = ? WHERE id = ?',
  ).bind(new Date().toISOString(), args.completionId);

  if (plan.missingQueries.length) {
    console.warn(
      `[quiz-answers] ${args.quizId} completion ${args.completionId}: ${plan.missingQueries.length} canonical question(s) not registered (${plan.missingQueries.slice(0, 3).join(', ')}…); nothing written`,
    );
    return { materialized: false, written: 0, skipped: plan.skipped, skipReasons: plan.skipReasons, missingQueries: plan.missingQueries };
  }

  if (plan.items.length === 0) {
    // Nothing maps (an unknown quiz, or a legacy answer shape): record that we
    // looked so the backfill does not return here forever.
    await markDone.run();
    return { materialized: true, written: 0, skipped: plan.skipped, skipReasons: plan.skipReasons, missingQueries: [] };
  }

  const planned = plan.items.map((item) => {
    const id = crypto.randomUUID();
    return { item, id, key: sealedAnswerKey(AUDIENCE, id) };
  });

  // Seal first. No row may ever point at a missing object, so a failed put
  // (or a failed batch below) removes what was already written.
  const written: string[] = [];
  const undo = () => Promise.allSettled(written.map((k) => SecretStore.deleteObject(env, k)));
  try {
    await runPool(planned, PUT_CONCURRENCY, async (p) => {
      await SecretStore.putJSON(
        env,
        p.key,
        { value: p.item.value, answer_data: p.item.answerData, reasoning: null },
        {
          tier: AUDIENCE,
          owner: args.userId,
          meta: {
            'q-id': p.item.qId,
            'user-id': String(args.userId),
            'audience': AUDIENCE,
            'answer-type-id': String(p.item.answerTypeId),
            'quiz-completion-id': args.completionId,
          },
        },
      );
      written.push(p.key);
    });
  } catch (e) {
    await undo();
    throw e;
  }

  const createdMs = Number.isFinite(Date.parse(args.createdAt)) ? Date.parse(args.createdAt) : Date.now();
  const stmts: unknown[] = [];
  for (const p of planned) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, storage_ref, poll_id, quiz_completion_id)
         VALUES (?, ?, ?, '[encrypted]', ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        p.id,
        p.item.qId,
        args.userId,
        String(p.item.answerTypeId),
        stripAnswerDataContent(p.item.answerData), // never content; null for a quiz item
        AUDIENCE,
        args.createdAt,
        plan.primaryType.get(p.item.qId) ?? DEFAULT_PRIMARY_TYPE,
        `qstorage:${p.key}`,
        args.completionId,
      ),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO answer_meta
         (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 0, ?)`,
      ).bind(p.id, p.item.qId, args.userId, PRIVACY_TIER, `qstorage:${p.key}`, createdMs),
    );
  }
  // One increment per row, as create.ts does for every Private answer.
  const perQuestion = new Map<string, number>();
  for (const p of planned) perQuestion.set(p.item.qId, (perQuestion.get(p.item.qId) ?? 0) + 1);
  for (const [qId, n] of perQuestion) {
    stmts.push(env.DB.prepare('UPDATE queries SET priv_answers = priv_answers + ? WHERE id = ?').bind(n, qId));
  }
  stmts.push(markDone);

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    await undo();
    throw e;
  }

  return { materialized: true, written: planned.length, skipped: plan.skipped, skipReasons: plan.skipReasons, missingQueries: [] };
}
