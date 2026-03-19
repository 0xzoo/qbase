-- Migration 0030: Add storage_ref column to Answers table
-- Phase 2: Private/Allowlist answers now stored in D1 (metadata) + Q Storage (encrypted value)
-- Previously these were Nillion-only, now we keep metadata in D1 for queryability

ALTER TABLE Answers ADD COLUMN storage_ref TEXT;
-- storage_ref format: 'qstorage:answers/private/{answerId}' or 'qstorage:answers/allowlist/{answerId}'
-- NULL for Public/Anon answers (value stored directly in D1)
