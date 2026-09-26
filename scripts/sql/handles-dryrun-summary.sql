-- Read-only preview of migrations/0077_handles.sql (one summary row). Writes nothing.
-- D1 returns rows only through --command, not --file:
--   npx wrangler d1 execute prod-qbase --remote --config wrangler.jsonc --json --command "$(cat scripts/sql/handles-dryrun-summary.sql)"

WITH norm AS (
  SELECT fid, fname, profile_source, username AS raw,
    CASE WHEN username IS NULL THEN NULL
         WHEN lower(trim(username)) = '' OR length(trim(username)) > 64
           OR lower(trim(username)) GLOB '*[^a-z0-9._-]*' OR lower(trim(username)) GLOB '[^a-z0-9]*' THEN NULL
         ELSE lower(trim(username)) END AS u,
    EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = Users.fid) AS has_fc,
    EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'ethereum' AND c.account_id = Users.fid AND lower(c.label) = lower(Users.fname)) AS has_ens
  FROM Users
),
filled AS (
  SELECT *,
    CASE WHEN u IS NOT NULL THEN u
         WHEN has_fc AND fname IS NOT NULL AND length(fname) BETWEEN 1 AND 64
           AND lower(fname) NOT GLOB '*[^a-z0-9._-]*' AND lower(fname) NOT GLOB '[^a-z0-9]*' THEN lower(fname)
         WHEN profile_source = 'ethereum' AND fname LIKE '%.eth' AND has_ens AND length(fname) BETWEEN 5 AND 64
           AND lower(fname) NOT GLOB '*[^a-z0-9._-]*' AND lower(fname) NOT GLOB '[^a-z0-9]*' THEN lower(fname)
    END AS h,
    CASE WHEN u IS NOT NULL THEN 'kept' WHEN has_fc THEN 'fc' ELSE 'ens' END AS src
  FROM norm
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY h ORDER BY (CASE WHEN has_fc AND lower(fname) = h THEN 1 ELSE 0 END) DESC, fid ASC) AS rn
  FROM filled WHERE h IS NOT NULL
)
SELECT
  (SELECT COUNT(*) FROM Users) AS users_rows,
  (SELECT COUNT(*) FROM Users WHERE fid >= 1099511627776) AS account_rows,
  (SELECT COUNT(*) FROM norm WHERE raw IS NOT NULL) AS usernames_now,
  (SELECT COUNT(*) FROM norm WHERE raw IS NOT NULL AND u IS NOT NULL AND u <> raw) AS lowercased,
  (SELECT COUNT(*) FROM norm WHERE raw IS NOT NULL AND u IS NULL) AS cleared_invalid,
  (SELECT COUNT(*) FROM filled WHERE src = 'fc' AND h IS NOT NULL) AS filled_from_fname,
  (SELECT COUNT(*) FROM filled WHERE src = 'ens' AND h IS NOT NULL) AS filled_from_ens,
  (SELECT COUNT(*) FROM ranked WHERE rn > 1) AS lose_to_duplicate,
  (SELECT COUNT(*) FROM ranked WHERE rn = 1) AS handles_after,
  (SELECT COUNT(*) FROM Users WHERE fid >= 1099511627776) - (SELECT COUNT(*) FROM ranked WHERE rn = 1 AND fid >= 1099511627776) AS accounts_to_pick;
