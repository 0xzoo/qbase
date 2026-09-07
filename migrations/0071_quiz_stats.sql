-- Migration number: 0071 	2026-09-08T00:00:00.000Z
-- Purpose: cache for the quiz correlation report (docs/quizzes/CONTENT-PLAN.md
--   §7.9, card t_589c4f56). The report is a read over every quiz completion —
--   opening each sealed snapshot and counting pairwise answer buckets — so it
--   is built once (daily cron, or POST /api/admin/quiz-stats/rebuild) and
--   served from here. Payload is aggregate counts only: no per-user data, and
--   every cell already passed the minimum-count suppression in
--   worker/services/quiz/QuizStatsService.ts.

CREATE TABLE IF NOT EXISTS quiz_stats (
  key       TEXT PRIMARY KEY,       -- e.g. 'correlations:v1'
  payload   TEXT NOT NULL,          -- JSON
  built_at  TEXT NOT NULL,          -- ISO8601
  n         INTEGER NOT NULL DEFAULT 0   -- users the payload was built from
);

-- Rollback:
-- DROP TABLE IF EXISTS quiz_stats;
