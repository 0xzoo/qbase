/**
 * usePrivateAnswerSubmit Hook
 * 
 * Handles E2E encrypted submission of private answers.
 * 
 * Flow:
 * 1. Derive Nillion key from wallet signature (if not cached)
 * 2. Create Nillion user client with the derived key
 * 3. Get delegation token from server (proves we're authenticated)
 * 4. Encrypt and store answer directly in Nillion (server never sees plaintext)
 * 5. Notify server for bookkeeping (counts, not data)
 */

import { useState, useCallback, useRef } from 'react';
import { useNillionKey } from './useNillionKey';
import { useAuth } from '../context/AuthContext';
import {
  createUserNillionClient,
  storePrivateAnswerE2E,
  storeAllowlistAnswerE2E,
  type PrivateAnswerData,
  type AllowlistAnswerData,
  type StorePrivateAnswerResult,
} from '../lib/nillion/browser-client';

interface UsePrivateAnswerSubmitReturn {
  /** Submit a private answer with E2E encryption (user_id + value encrypted) */
  submitPrivateAnswer: (data: PrivateAnswerData) => Promise<StorePrivateAnswerResult>;
  /** Submit an allowlist answer with E2E encryption (user_id plain, value encrypted) */
  submitAllowlistAnswer: (data: AllowlistAnswerData) => Promise<StorePrivateAnswerResult>;
  /** Whether submission is in progress */
  isSubmitting: boolean;
  /** Error from last submission attempt */
  error: string | null;
  /** Whether we can submit (authenticated + wallet connected) */
  canSubmit: boolean;
  /** Whether wallet needs to be connected first */
  needsWalletConnection: boolean;
  /** Whether key derivation is needed (will prompt wallet signature) */
  needsKeyDerivation: boolean;
}

export function usePrivateAnswerSubmit(): UsePrivateAnswerSubmitReturn {
  const { user, getAuthToken } = useAuth();
  const { deriveKey, derivedSeed, canDeriveKey, isWalletConnected } = useNillionKey();
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Prevent concurrent submissions
  const submittingRef = useRef(false);

  const submitPrivateAnswer = useCallback(async (
    data: PrivateAnswerData
  ): Promise<StorePrivateAnswerResult> => {
    if (!user?.fid) {
      throw new Error('Must be authenticated to submit answers');
    }

    if (!canDeriveKey) {
      throw new Error('Wallet must be connected for private answers');
    }

    // Prevent concurrent submissions
    if (submittingRef.current) {
      throw new Error('Submission already in progress');
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      // Step 1: Derive key if not already cached (prompts wallet signature)
      let seed = derivedSeed;
      if (!seed) {
        seed = await deriveKey();
      }

      // Step 2: Create Nillion client
      const nillionClient = await createUserNillionClient(seed);
      
      // Step 3: Get user's DID for the delegation token request
      const userDid = await nillionClient.getId();

      // Step 4: Get delegation token from server for private collection
      const token = getAuthToken();
      const delegationResponse = await fetch('/api/nillion/delegation-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        body: JSON.stringify({ userDid, collectionType: 'private' }),
      });

      if (!delegationResponse.ok) {
        const errorText = await delegationResponse.text();
        throw new Error(`Failed to get delegation token: ${errorText}`);
      }

      const { delegationToken, collectionId } = await delegationResponse.json() as {
        delegationToken: string;
        collectionId: string;
      };

      // Step 5: Store with E2E encryption
      const result = await storePrivateAnswerE2E(
        nillionClient,
        data,
        delegationToken,
        collectionId,
        user.fid,
      );

      // Step 6: Notify server for points & count (privacy-preserving)
      // Server only gets q_id + audience - doesn't store user-question link
      const notifyResponse = await fetch('/api/answers/notify-private', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        body: JSON.stringify({
          q_id: data.q_id,
          audience: 'Private',
        }),
      });

      if (!notifyResponse.ok) {
        const errorData = await notifyResponse.json().catch(() => ({ error: 'Unknown error' }));
        console.error('[E2E] Failed to notify server:', errorData);
        // Don't throw - the E2E storage succeeded, just bookkeeping failed
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit private answer';
      setError(message);
      throw err;
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }, [user?.fid, canDeriveKey, derivedSeed, deriveKey, getAuthToken]);

  /**
   * Submit an allowlist answer with E2E encryption.
   * Allowlist answers have user_id plain, value encrypted.
   */
  const submitAllowlistAnswer = useCallback(async (
    data: AllowlistAnswerData
  ): Promise<StorePrivateAnswerResult> => {
    if (!user?.fid) {
      throw new Error('Must be authenticated to submit answers');
    }

    if (!canDeriveKey) {
      throw new Error('Wallet must be connected for allowlist answers');
    }

    // Prevent concurrent submissions
    if (submittingRef.current) {
      throw new Error('Submission already in progress');
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      // Step 1: Derive key if not already cached (prompts wallet signature)
      let seed = derivedSeed;
      if (!seed) {
        seed = await deriveKey();
      }

      // Step 2: Create Nillion client
      const nillionClient = await createUserNillionClient(seed);
      
      // Step 3: Get user's DID for the delegation token request
      const userDid = await nillionClient.getId();

      // Step 4: Get delegation token from server for allowlist collection
      const token = getAuthToken();
      const delegationResponse = await fetch('/api/nillion/delegation-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        body: JSON.stringify({ userDid, collectionType: 'allowlist' }),
      });

      if (!delegationResponse.ok) {
        const errorText = await delegationResponse.text();
        throw new Error(`Failed to get delegation token: ${errorText}`);
      }

      const { delegationToken, collectionId } = await delegationResponse.json() as {
        delegationToken: string;
        collectionId: string;
      };

      // Step 5: Store with E2E encryption
      const result = await storeAllowlistAnswerE2E(
        nillionClient,
        data,
        delegationToken,
        collectionId,
        user.fid,
      );

      // Step 6: Notify server for points & count (privacy-preserving)
      // Server only gets q_id + audience - doesn't store user-question link
      const notifyResponse = await fetch('/api/answers/notify-private', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` }),
        },
        body: JSON.stringify({
          q_id: data.q_id,
          audience: 'Allowlist',
        }),
      });

      if (!notifyResponse.ok) {
        const errorData = await notifyResponse.json().catch(() => ({ error: 'Unknown error' }));
        console.error('[E2E] Failed to notify server:', errorData);
        // Don't throw - the E2E storage succeeded, just bookkeeping failed
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit allowlist answer';
      setError(message);
      throw err;
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }, [user?.fid, canDeriveKey, derivedSeed, deriveKey, getAuthToken]);

  return {
    submitPrivateAnswer,
    submitAllowlistAnswer,
    isSubmitting,
    error,
    canSubmit: !!user?.fid && canDeriveKey,
    needsWalletConnection: !!user?.fid && !isWalletConnected,
    needsKeyDerivation: !!user?.fid && isWalletConnected && !derivedSeed,
  };
}

export default usePrivateAnswerSubmit;

