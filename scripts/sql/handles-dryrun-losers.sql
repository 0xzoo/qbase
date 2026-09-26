/* Read-only preview of migrations/0077_handles.sql: every row that would lose its name to a duplicate, and the row that keeps it. Writes nothing.
   D1 returns rows only through --command (not --file), and the command must not start with a dash:
   npx wrangler d1 execute prod-qbase --remote --config wrangler.jsonc --json --command "$(cat scripts/sql/handles-dryrun-losers.sql)" */
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
    END AS h
  FROM norm
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY h ORDER BY (CASE WHEN has_fc AND lower(fname) = h THEN 1 ELSE 0 END) DESC, fid ASC) AS rn,
    FIRST_VALUE(fid) OVER (PARTITION BY h ORDER BY (CASE WHEN has_fc AND lower(fname) = h THEN 1 ELSE 0 END) DESC, fid ASC) AS keeper
  FROM filled WHERE h IS NOT NULL
)
SELECT h AS handle, fid AS loses, keeper AS keeps, profile_source, raw AS username_now, fname
  FROM ranked WHERE rn > 1 ORDER BY h;
