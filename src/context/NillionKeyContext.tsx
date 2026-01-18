/**
 * NillionKeyContext - Global state for Nillion encryption key
 * 
 * This context stores the derived encryption key globally so it's shared
 * across all components. Without this, each useNillionKey() hook instance
 * would have its own local state, causing repeated wallet signature prompts.
 * 
 * The key derivation flow:
 * 1. User connects wallet (via Wagmi)
 * 2. User signs a deterministic message to derive the encryption key
 * 3. The derived seed is stored in this context (shared globally)
 * 4. All E2E encryption operations use the cached key
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useSignMessage, useAccount } from 'wagmi';
import { keccak256, toBytes, type Hex } from 'viem';
import { useAuth } from './AuthContext';

// Message shown in wallet when deriving encryption key
// This is NOT a transaction - just a signature to derive a deterministic encryption key
const NILLION_KEY_MESSAGE = `Sign this message to enable end-to-end encryption and decryption of your qbase answers.

FID: `;

interface NillionKeyContextType {
  /** The derived seed (hex string, no 0x prefix), or null if not yet derived */
  derivedSeed: string | null;
  /** Whether key derivation is in progress */
  isDerivingKey: boolean;
  /** Error from last derivation attempt */
  error: string | null;
  /** Derive the Nillion key (prompts wallet signature) */
  deriveKey: () => Promise<string>;
  /** Clear the cached key (e.g., on logout) */
  clearKey: () => void;
  /** Whether wallet is connected */
  isWalletConnected: boolean;
  /** Connected wallet address */
  walletAddress: string | undefined;
  /** Whether we can derive a key (authenticated + wallet connected) */
  canDeriveKey: boolean;
}

const NillionKeyContext = createContext<NillionKeyContextType | null>(null);

export function NillionKeyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  
  const [derivedSeed, setDerivedSeed] = useState<string | null>(null);
  const [isDerivingKey, setIsDerivingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Prevent concurrent derivation attempts
  const derivingRef = useRef(false);
  // Store a promise for in-flight derivation so concurrent callers can await it
  const derivationPromiseRef = useRef<Promise<string> | null>(null);

  // Clear the key when user logs out (user becomes null)
  useEffect(() => {
    if (!user?.fid) {
      // User logged out - clear the derived key
      setDerivedSeed(null);
      setError(null);
      derivingRef.current = false;
      derivationPromiseRef.current = null;
    }
  }, [user?.fid]);

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

    // If derivation is already in progress, return the existing promise
    if (derivingRef.current && derivationPromiseRef.current) {
      return derivationPromiseRef.current;
    }

    // Start new derivation
    derivingRef.current = true;
    setIsDerivingKey(true);
    setError(null);

    const derivationPromise = (async () => {
      try {
        // Deterministic message - same FID = same message = same key
        const messageText = `${NILLION_KEY_MESSAGE}${user.fid}`;
        
        // Sign with wallet (user sees wallet popup)
        const signature = await signMessageAsync({ 
          account: address,
          message: messageText,
        });
        
        // Derive 32-byte seed from signature using keccak256
        const seed = keccak256(toBytes(signature as Hex));
        
        // Remove 0x prefix for Nillion compatibility
        const seedHex = seed.slice(2);
        
        // Cache the derived seed globally
        setDerivedSeed(seedHex);
        
        return seedHex;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to derive encryption key';
        setError(errorMessage);
        throw err;
      } finally {
        setIsDerivingKey(false);
        derivingRef.current = false;
        derivationPromiseRef.current = null;
      }
    })();

    derivationPromiseRef.current = derivationPromise;
    return derivationPromise;
  }, [user?.fid, isConnected, address, derivedSeed, signMessageAsync]);

  const clearKey = useCallback(() => {
    setDerivedSeed(null);
    setError(null);
    derivingRef.current = false;
    derivationPromiseRef.current = null;
  }, []);

  const value: NillionKeyContextType = {
    derivedSeed,
    isDerivingKey,
    error,
    deriveKey,
    clearKey,
    isWalletConnected: isConnected,
    walletAddress: address,
    canDeriveKey: !!user?.fid && isConnected,
  };

  return (
    <NillionKeyContext.Provider value={value}>
      {children}
    </NillionKeyContext.Provider>
  );
}

/**
 * Hook to access the global Nillion key context.
 * Must be used within a NillionKeyProvider.
 */
export function useNillionKeyContext(): NillionKeyContextType {
  const context = useContext(NillionKeyContext);
  if (!context) {
    throw new Error('useNillionKeyContext must be used within a NillionKeyProvider');
  }
  return context;
}

export default NillionKeyProvider;
