-- Migration: Remove unused points columns from users table
-- Date: 2026-01-02
-- Reason: Points are now managed exclusively in KV_USER_POINTS.
--         The points_balance and points_allowance columns in the users table
--         are not synchronized with KV and cause confusion.
-- 
-- KV_USER_POINTS is the source of truth for:
--   - allowance: Daily grant (resets)
--   - earned: Monthly rewards (claimable for $QQ)
--   - balance: Purchased QP (persists)

-- Drop unused points columns
ALTER TABLE users DROP COLUMN points_balance;
ALTER TABLE users DROP COLUMN points_allowance;

