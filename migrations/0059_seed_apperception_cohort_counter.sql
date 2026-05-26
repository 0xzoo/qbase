-- Seed the apperception cohort counter.
--
-- When apperception shipped, its row in quiz_cohort_counters was never created
-- (0058 seeded only bartlet and values). The airdrop pipeline bumps the counter
-- with `UPDATE ... WHERE quiz_id='apperception' RETURNING count`; with no row
-- the UPDATE matches nothing and runQuizAirdrop returns
-- { kind: 'error', error: 'cohort counter missing' } — which surfaces as a
-- silent "pending" (no badge), so EVERY apperception airdrop failed at this step.
--
-- Same 1000-slot cap as bartlet/values; separate pool. Idempotent (the row was
-- also inserted manually in prod on 2026-05-26).
INSERT OR IGNORE INTO quiz_cohort_counters (quiz_id, count, cap)
VALUES ('apperception', 0, 1000);
