/**
 * useNillionKey Hook
 * 
 * Derives a Nillion encryption keypair from a wallet signature.
 * The key is deterministic: same wallet + same FID = same key.
 * 
 * Flow:
 * 1. User signs a deterministic message with their wallet
 * 2. The signature is hashed to produce a 32-byte seed
 * 3. This seed becomes the Nillion private key
 * 
 * Security properties:
 * - Private key never leaves the wallet
 * - Only the signature (a public operation) is used
 * - Deterministic: same key can be recovered on any device with the same wallet
 */

import { useSignMessage, useAccount } from 'wagmi';
import { keccak256, toBytes, type Hex } from 'viem';
import { useAuth } from '../context/AuthContext';
import { useState, useCallback, useRef } from 'react';

const NILLION_KEY_MESSAGE_PREFIX = 'Qbase encryption key for FID ';

interface UseNillionKeyReturn {
  /** Derive the Nillion key (prompts wallet signature) */
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

export function useNillionKey(): UseNillionKeyReturn {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  
  const [derivedSeed, setDerivedSeed] = useState<string | null>(null);
  const [isDerivingKey, setIsDerivingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Prevent concurrent derivation attempts
  const derivingRef = useRef(false);

  const deriveKey = useCallback(async (): Promise<string> => {
    if (!user?.fid) {
      throw new Error('Must be authenticated to derive encryption key');
    }
    
    if (!isConnected || !address) {
      throw new Error('Wallet must be connected to derive encryption key');
    }

    // Return cached key if available
    if (derivedSeed) {
      return derivedSeed;
    }

    // Prevent concurrent derivation
    if (derivingRef.current) {
      throw new Error('Key derivation already in progress');
    }

    derivingRef.current = true;
    setIsDerivingKey(true);
    setError(null);

    try {
      // Deterministic message - same FID = same message = same key
      const messageText = `${NILLION_KEY_MESSAGE_PREFIX}${user.fid}`;
      
      // Sign with wallet (user sees wallet popup)
      // wagmi v3 uses the connected account automatically
      const signature = await signMessageAsync({ 
        account: address,
        message: messageText,
      });
      
      // Derive 32-byte seed from signature using keccak256
      const seed = keccak256(toBytes(signature as Hex));
      
      // Remove 0x prefix for Nillion compatibility
      const seedHex = seed.slice(2);
      
      // Cache the derived seed
      setDerivedSeed(seedHex);
      
      return seedHex;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to derive encryption key';
      setError(errorMessage);
      throw err;
    } finally {
      setIsDerivingKey(false);
      derivingRef.current = false;
    }
  }, [user?.fid, isConnected, address, derivedSeed, signMessageAsync]);

  const clearKey = useCallback(() => {
    setDerivedSeed(null);
    setError(null);
  }, []);

  return {
    deriveKey,
    clearKey,
    derivedSeed,
    isDerivingKey,
    isWalletConnected: isConnected,
    walletAddress: address,
    canDeriveKey: !!user?.fid && isConnected,
    error,
  };
}

export default useNillionKey;

