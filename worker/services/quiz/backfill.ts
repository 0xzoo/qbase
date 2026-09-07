/**
 * backfillQuizAnswers — Answers rows for completions that do not have them
 * yet (docs/quizzes/CONTENT-PLAN.md §6 V2, data half; card t_b544c849).
 *
 * Selects `quiz_completions` with `answers_materialized_at` NULL in rowid
 * order from a cursor, opens each sealed snapshot through
 * `readCompletionAnswers` (the only decrypt path for completions) and hands
 * the answers to `materializeCompletionAnswers`, stamped with the completion's
 * `completed_at` so the rows date from when the person actually answered.
 *
 * Idempotent: a materialised completion is never selected again. A
 * completion the writer cannot serve — a quiz whose canonical questions are
 * not registered, a non-private visibility (V1 is Private rows only), a
 * snapshot that will not open — is counted, left NULL and passed by the
 * cursor, so the sweep always terminates. It doubles as the retry path for a
 * live write that failed.
 */

import { readCompletionAnswers, type CompletionRow } from '../../routes/quiz-completions';
import { isMaterializedQuiz } from './canonicalAnswers';
import { materializeCompletionAnswers, planCompletionAnswers, type Env, type SkipCounts } from './QuizAnswersService';

export interface BackfillOpts {
  dryRun?: boolean;
  /** completions per call; default 25, max 100 */
  limit?: number;
  /** rowid from the previous report's nextCursor */
  cursor?: string | null;
  quiz?: string;
}

export interface BackfillReport {
  dryRun: boolean;
  processed: number;
  /** completions now marked (rows written, or nothing to map) */
  materialized: number;
  rowsWritten: number;
  /** answers with no canonical mapping; `empty_text` is an open item left blank */
  skippedItems: number;
  skipReasons: SkipCounts;
  /** completions with no answers at all (marked, nothing to write) */
  empty: number;
  /** completions whose quiz has unregistered canonical questions (left NULL) */
  unregistered: Array<{ id: string; quiz: string; missing: string[] }>;
  /** non-private visibility or a quiz this service does not cover (left NULL) */
  unsupported: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
}

type Row = CompletionRow & { rid: number; quiz_id: string; completed_at: number };

function addSkips(into: SkipCounts, from: SkipCounts): void {
  for (const [k, v] of Object.entries(from)) {
    const key = k as keyof SkipCounts;
    into[key] = (into[key] ?? 0) + (v ?? 0);
  }
}

export async function backfillQuizAnswers(env: Env, opts: BackfillOpts = {}): Promise<BackfillReport> {
  const dryRun = !!opts.dryRun;
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const cursor = Number(opts.cursor ?? 0) || 0;

  const where = ['answers_materialized_at IS NULL', 'rowid > ?'];
  const binds: unknown[] = [cursor];
  if (opts.quiz) {
    where.push('quiz_id = ?');
    binds.push(opts.quiz);
  }
  const rows = await env.DB.prepare(
    `SELECT rowid AS rid, * FROM quiz_completions WHERE ${where.join(' AND ')} ORDER BY rowid ASC LIMIT ?`,
  ).bind(...binds, limit).all();
  const results = (rows.results ?? []) as Row[];

  const report: BackfillReport = {
    dryRun, processed: 0, materialized: 0, rowsWritten: 0, skippedItems: 0, skipReasons: {}, empty: 0,
    unregistered: [], unsupported: 0, errors: [], nextCursor: null, done: results.length < limit,
  };

  for (const row of results) {
    report.processed++;
    report.nextCursor = String(row.rid);

    if (row.visibility !== 'private' || !isMaterializedQuiz(row.quiz_id)) {
      report.unsupported++;
      continue;
    }

    let answers: unknown[] | null;
    try {
      answers = await readCompletionAnswers(env, row);
    } catch (e) {
      report.errors.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!answers || answers.length === 0) {
      report.empty++;
      if (!dryRun) {
        await env.DB.prepare('UPDATE quiz_completions SET answers_materialized_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), row.id).run();
        report.materialized++;
      }
      continue;
    }

    const completedMs = Number(row.completed_at);
    const createdAt = new Date(Number.isFinite(completedMs) && completedMs > 0 ? completedMs : Date.now()).toISOString();

    try {
      if (dryRun) {
        const plan = await planCompletionAnswers(env, row.quiz_id, answers);
        report.skippedItems += plan.skipped;
        addSkips(report.skipReasons, plan.skipReasons);
        if (plan.missingQueries.length) {
          report.unregistered.push({ id: row.id, quiz: row.quiz_id, missing: plan.missingQueries });
        } else {
          report.materialized++;
          report.rowsWritten += plan.items.length;
        }
        continue;
      }
      const r = await materializeCompletionAnswers(env, {
        completionId: row.id, quizId: row.quiz_id, userId: Number(row.user_id), answers, createdAt,
      });
      report.skippedItems += r.skipped;
      addSkips(report.skipReasons, r.skipReasons);
      if (r.materialized) {
        report.materialized++;
        report.rowsWritten += r.written;
      } else {
        report.unregistered.push({ id: row.id, quiz: row.quiz_id, missing: r.missingQueries });
      }
    } catch (e) {
      report.errors.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return report;
}
