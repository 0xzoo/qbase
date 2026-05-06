-- Migration number: 0056 	 2026-05-05T00:00:00.000Z
-- Purpose: Add `date` as a new question/answer type so questions can collect
--   ISO date (or datetime) answers — initially driven by quiz needs (e.g.
--   capturing date-of-birth for a horoscope quiz). Mirrors how `scale` carries
--   `scale_config`; here `date_config` is JSON `{ include_time?: boolean }`.

INSERT INTO answer_types (id, name, description, json_schema) VALUES
  (5, 'date', 'ISO date or datetime answer', '{"iso": "string"}');

ALTER TABLE queries ADD COLUMN date_config TEXT; -- JSON string: { include_time?: boolean }

-- Rollback (if needed):
-- ALTER TABLE queries DROP COLUMN date_config;
-- DELETE FROM answer_types WHERE id = 5;
