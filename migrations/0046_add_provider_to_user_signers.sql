-- 0046: Add provider column to user_signers for pluggable cast backends
--
-- Supports the CastRouter abstraction: Neynar, Snapchain, and Hypersnap
-- signers coexist in the same table, selected by provider column.
--
-- Existing rows default to 'neynar' (no data migration needed).
-- Snapchain signers: provider='snapchain', signer_uuid=NULL, public_key=Ed25519 hex
-- Hypersnap signers: provider='hypersnap', signer_uuid=NULL, public_key=Ed25519 hex
-- Neynar signers:    provider='neynar', signer_uuid=Neynar UUID, public_key=any

-- Add provider column. Default 'neynar' covers all existing rows.
ALTER TABLE user_signers ADD COLUMN provider TEXT NOT NULL DEFAULT 'neynar';

-- Composite index for CastRouter lookups: "get me an approved signer for FID X on provider Y"
CREATE INDEX idx_user_signers_fid_provider_status ON user_signers(fid, provider, status);
