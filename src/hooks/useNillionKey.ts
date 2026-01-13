/**
 * useNillionKey Hook
 * 
 * Provides access to the Nillion encryption key derived from a wallet signature.
 * The key is deterministic: same wallet + same FID = same key.
 * 
 * IMPORTANT: This hook now uses global context (NillionKeyContext) to store
 * the derived seed. This ensures all components share the same key, preventing
 * repeated wallet signature prompts when navigating between questions.
 * 
 * Flow:
 * 1. User signs a deterministic message with their wallet (once)
 * 2. The signature is hashed to produce a 32-byte seed
 * 3. This seed is stored globally in NillionKeyContext
 * 4. All components using this hook share the same cached key
 * 
 * Security properties:
 * - Private key never leaves the wallet
 * - Only the signature (a public operation) is used
 * - Deterministic: same key can be recovered on any device with the same wallet
 */

import { useNillionKeyContext } from '../context/NillionKeyContext';

interface UseNillionKeyReturn {
  /** Derive the Nillion key (prompts wallet signature if not cached) */
  deriveKey: () => Promise<string>;
  /** Clear the cached key (e.g., on logout) */
  clearKey: () => void;
  /** The derived seed (hex string, no 0x prefix), or null if not yet derived */
  derivedSeed: string | null;
  /** Whether key derivation is in progress */
  isDerivingKey: boolean;
  /** Whether wallet is connected */
  isWalletConnected: boolean;
  /** Connected wallet address */
  walletAddress: string | undefined;
  /** Whether we can derive a key (authenticated + wallet connected) */
  canDeriveKey: boolean;
  /** Error from last derivation attempt */
  error: string | null;
}

/**
 * Hook to access the global Nillion encryption key.
 * 
 * The key is derived once and cached globally in NillionKeyContext.
 * All components using this hook share the same key state.
 */
export function useNillionKey(): UseNillionKeyReturn {
  const context = useNillionKeyContext();
  
  return {
    deriveKey: context.deriveKey,
    clearKey: context.clearKey,
    derivedSeed: context.derivedSeed,
    isDerivingKey: context.isDerivingKey,
    isWalletConnected: context.isWalletConnected,
    walletAddress: context.walletAddress,
    canDeriveKey: context.canDeriveKey,
    error: context.error,
  };
}

export default useNillionKey;
