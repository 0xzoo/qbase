-- qbase handles (worker/services/accounts/HandleService.ts).
--
-- Users.username becomes the handle: lowercase, unique where set, served at
-- /ask/:handle. Accounts that came with a name keep it: Farcaster accounts
-- their fname, Ethereum accounts their verified ENS name. Everyone else is
-- asked to pick one.
--
-- Safe on any data: normalize, fill, then drop duplicates deterministically
-- (the account that proved the name on Farcaster wins, then the lowest key),
-- then index. Read-only preview: scripts/sql/handles-dryrun.sql.

-- 1. Normalize: trim + lowercase; clear empties and anything /ask/ cannot address.
UPDATE Users SET username = lower(trim(username)) WHERE username IS NOT NULL;
UPDATE Users SET username = NULL
 WHERE username IS NOT NULL
   AND (username = '' OR length(username) > 64
        OR username GLOB '*[^a-z0-9._-]*' OR username GLOB '[^a-z0-9]*');

-- 2. Fill: Farcaster accounts take their fname; Ethereum accounts their ENS name
--    when it is the verified label on their ethereum credential.
UPDATE Users SET username = lower(fname)
 WHERE username IS NULL AND fname IS NOT NULL
   AND EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = Users.fid)
   AND length(fname) BETWEEN 1 AND 64
   AND lower(fname) NOT GLOB '*[^a-z0-9._-]*' AND lower(fname) NOT GLOB '[^a-z0-9]*';

UPDATE Users SET username = lower(fname)
 WHERE username IS NULL AND profile_source = 'ethereum' AND fname LIKE '%.eth'
   AND EXISTS (SELECT 1 FROM account_credentials c
                WHERE c.kind = 'ethereum' AND c.account_id = Users.fid AND lower(c.label) = lower(Users.fname))
   AND length(fname) BETWEEN 5 AND 64
   AND lower(fname) NOT GLOB '*[^a-z0-9._-]*' AND lower(fname) NOT GLOB '[^a-z0-9]*';

-- 3. Duplicates: a row keeps its name unless another row holding the same name
--    ranks higher. Rank: proved on Farcaster (a farcaster credential and an
--    fname equal to the name) first, then the lowest key (rowid = fid).
UPDATE Users SET username = NULL
 WHERE username IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM Users o
      WHERE o.username = Users.username AND o.fid <> Users.fid
        AND (
          (CASE WHEN lower(o.fname) = o.username
                 AND EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = o.fid)
                THEN 1 ELSE 0 END)
          >
          (CASE WHEN lower(Users.fname) = Users.username
                 AND EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = Users.fid)
                THEN 1 ELSE 0 END)
          OR (
            (CASE WHEN lower(o.fname) = o.username
                   AND EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = o.fid)
                  THEN 1 ELSE 0 END)
            =
            (CASE WHEN lower(Users.fname) = Users.username
                   AND EXISTS (SELECT 1 FROM account_credentials c WHERE c.kind = 'farcaster' AND c.account_id = Users.fid)
                  THEN 1 ELSE 0 END)
            AND o.fid < Users.fid
          )
        )
   );

-- 4. One holder per handle from here on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON Users(username) WHERE username IS NOT NULL;
