-- Migration: Reset private answer counts for new collections
-- Date: 2026-01-09
-- Purpose: Reset priv_answers to 0 since we're migrating to new Nillion collections
-- Context: Old private answers are in deprecated collections, new answers will use new schemas

-- Reset all private answer counts to 0
UPDATE queries SET priv_answers = 0 WHERE priv_answers > 0;

-- Verification query (run after migration)
-- SELECT COUNT(*) as questions_with_priv_answers FROM queries WHERE priv_answers > 0;
-- Expected result: 0
