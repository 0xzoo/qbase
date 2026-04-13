/**
 * bartlet-backfill — one-shot backfill for early quiz completers.
 *
 * POST /api/admin/bartlet-backfill
 *
 * Scans all KV sessions, writes FID index + quiz_completions rows for
 * completed sessions that are missing them. Safe to run multiple times
 * (idempotent: checks for existing FID index and quiz_completion rows).
 *
 * Remove this route after backfill is complete.
 */

import {
  loadSessionForFid,
  saveFidIndex,
  type BartletSession,
} from '../services/bartlet/session';
import { BARTLET_LENGTH } from '../services/bartlet/questions';
import { freeTierResult } from '../services/bartlet/scoring';
import { createQuizCompletion } from './quiz-completions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function handleBartletBackfill(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/bartlet-backfill' || request.method !== 'POST') {
    return null;
  }

  // Simple auth gate — require the admin secret to prevent accidental invocation
  const secret = request.headers.get('X-Backfill-Secret');
  if (secret !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const kv: KVNamespace = env.BARTLET_SESSIONS;
  const stats = {
    totalSessions: 0,
    completed: 0,
    fidIndexWritten: 0,
    fidIndexSkipped: 0,
    quizCompletionWritten: 0,
    quizCompletionSkipped: 0,
    errors: [] as string[],
  };

  // List all session keys in KV
  let cursor: string | undefined;
  const sessions: BartletSession[] = [];

  do {
    const list = await kv.list({ prefix: 'session:', cursor, limit: 100 });
    for (const key of list.keys) {
      stats.totalSessions++;
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try {
        const session = JSON.parse(raw) as BartletSession;
        if (session.index >= BARTLET_LENGTH) {
          sessions.push(session);
        }
      } catch {
        stats.errors.push(`Failed to parse ${key.name}`);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  stats.completed = sessions.length;

  // Backfill each completed session
  for (const session of sessions) {
    // 1. FID index
    try {
      const existing = await loadSessionForFid(env, session.fid);
      if (existing) {
        stats.fidIndexSkipped++;
      } else {
        await saveFidIndex(env, session.fid, session.id);
        stats.fidIndexWritten++;
      }
    } catch (e) {
      stats.errors.push(`FID index for fid=${session.fid}: ${e}`);
    }

    // 2. Quiz completion record
    try {
      const existingCompletion = await env.DB.prepare(
        "SELECT id FROM quiz_completions WHERE quiz_id = 'bartlet' AND user_id = ?"
      )
        .bind(session.fid)
        .first();

      if (existingCompletion) {
        stats.quizCompletionSkipped++;
      } else {
        const freeResult = freeTierResult(session.answers);
        await createQuizCompletion(env, {
          quizId: 'bartlet',
          userId: session.fid,
          answersJson: JSON.stringify(session.answers),
          scores: {
            dominant: freeResult.dominant,
            runnerUp: freeResult.runnerUp,
            hybrid: freeResult.hybrid,
            displayLabel: freeResult.displayLabel,
          },
          resultCategory: freeResult.displayLabel,
        });
        stats.quizCompletionWritten++;
      }
    } catch (e) {
      stats.errors.push(`Quiz completion for fid=${session.fid}: ${e}`);
    }
  }

  return Response.json({ ok: true, stats });
}
