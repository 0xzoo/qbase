/**
 * Farcaster Protocol Constants
 * 
 * EIP-712 typed data structures for Farcaster SignedKeyRequestValidator
 * Used when registering signers with the Farcaster protocol
 * 
 * Contract: 0x00000000fc700472606ed4fa22623acf62c60553 (Optimism Mainnet)
 * Documentation: https://docs.farcaster.xyz/reference/contracts/reference/signed-key-request-validator
 */

/**
 * EIP-712 Domain for Farcaster SignedKeyRequestValidator
 * This domain is used to sign typed data for signer key requests
 */
export const SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10, // Optimism Mainnet
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' as const,
} as const;

/**
 * EIP-712 Type definition for SignedKeyRequest
 * Used to structure the data when signing a key request
 */
export const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
] as const;

/**
 * Default deadline duration for signed key requests (24 hours in seconds)
 */
export const DEFAULT_SIGNED_KEY_DEADLINE = 86400;

