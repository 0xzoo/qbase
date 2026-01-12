/**
 * usePrivateAnswerRead Hook
 * 
 * Handles reading E2E encrypted private/allowlist answers.
 * 
 * Flow:
 * 1. Derive Nillion key from wallet signature (if not cached)
 * 2. Create Nillion user client with the derived key
 * 3. List or read answers directly from Nillion
 * 4. SDK decrypts automatically with user's key
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNillionKey } from './useNillionKey';
import { useAuth } from '../context/AuthContext';
import {
  createUserNillionClient,
  listOwnAnswers,
  listOwnAnswersForQuestion,
  readOwnPrivateAnswer,
  type StoredPrivateAnswer,
} from '../lib/nillion/browser-client';
import type { SecretVaultUserClient } from '@nillion/secretvaults';

// Cache for collection IDs (fetched from server once)
let cachedPrivateCollectionId: string | null = null;
let cachedAllowlistCollectionId: string | null = null;

interface UsePrivateAnswerReadReturn {
  /** All user's E2E encrypted answers (from both private and allowlist collections) */
  answers: StoredPrivateAnswer[];
  /** Whether answers are being loaded */
  isLoading: boolean;
  /** Error from last operation */
  error: string | null;
  /** Refresh the answers list */
  refresh: () => Promise<void>;
  /** Get answers for a specific question */
  getAnswersForQuestion: (questionId: string) => Promise<StoredPrivateAnswer[]>;
  /** Read a single answer by ID */
  readAnswer: (answerId: string, audience: 'Private' | 'Allowlist') => Promise<StoredPrivateAnswer | null>;
  /** Whether the user can read (authenticated + wallet connected) */
  canRead: boolean;
  /** Whether wallet needs to be connected first */
  needsWalletConnection: boolean;
  /** Whether key derivation is needed (will prompt wallet signature) */
  needsKeyDerivation: boolean;
  /** The Nillion client (if initialized) */
  client: SecretVaultUserClient | null;
  /** Private collection ID */
  privateCollectionId: string | null;
  /** Allowlist collection ID */
  allowlistCollectionId: string | null;
}

export function usePrivateAnswerRead(): UsePrivateAnswerReadReturn {
  const { user } = useAuth();
  const { deriveKey, derivedSeed, canDeriveKey, isWalletConnected } = useNillionKey();
  
  const [answers, setAnswers] = useState<StoredPrivateAnswer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<SecretVaultUserClient | null>(null);
  const [privateCollectionId, setPrivateCollectionId] = useState<string | null>(cachedPrivateCollectionId);
  const [allowlistCollectionId, setAllowlistCollectionId] = useState<string | null>(cachedAllowlistCollectionId);
  const fetchingConfigRef = useRef(false);

  // Fetch collection IDs from server on mount
  useEffect(() => {
    if ((privateCollectionId && allowlistCollectionId) || fetchingConfigRef.current) return;
    
    fetchingConfigRef.current = true;
    fetch('/api/nillion/config')
      .then(res => {
        if (!res.ok) {
          throw new Error(`Config fetch failed: ${res.status}`);
        }
        return res.json();
      })
      .then((data: { privateCollectionId?: string; allowlistCollectionId?: string }) => {
        if (data.privateCollectionId) {
          cachedPrivateCollectionId = data.privateCollectionId;
          setPrivateCollectionId(data.privateCollectionId);
        }
        if (data.allowlistCollectionId) {
          cachedAllowlistCollectionId = data.allowlistCollectionId;
          setAllowlistCollectionId(data.allowlistCollectionId);
        }
        if (!data.privateCollectionId && !data.allowlistCollectionId) {
          console.error('[Nillion] Config returned but no collection IDs:', data);
          setError('Nillion configuration not available');
        }
      })
      .catch(err => {
        console.error('[Nillion] Failed to fetch config:', err);
        setError('Failed to load encryption configuration');
      })
      .finally(() => {
        fetchingConfigRef.current = false;
      });
  }, [privateCollectionId, allowlistCollectionId]);

  // Initialize client when we have a derived seed
  useEffect(() => {
    if (derivedSeed && !client) {
      createUserNillionClient(derivedSeed)
        .then(setClient)
        .catch(err => {
          console.error('Failed to create Nillion client:', err);
          setError('Failed to initialize encryption client');
        });
    }
  }, [derivedSeed, client]);

  // Clear client when seed is cleared (e.g., logout)
  useEffect(() => {
    if (!derivedSeed) {
      setClient(null);
      setAnswers([]);
    }
  }, [derivedSeed]);

  /**
   * Ensure we have a client, prompting for wallet signature if needed
   */
  const ensureClient = useCallback(async (): Promise<SecretVaultUserClient | null> => {
    if (client) return client;
    
    if (!canDeriveKey) {
      setError('Wallet must be connected to read private answers');
      return null;
    }

    try {
      const seed = await deriveKey();
      const newClient = await createUserNillionClient(seed);
      setClient(newClient);
      return newClient;
    } catch (err) {
      console.error('Failed to derive key or create client:', err);
      setError('Failed to initialize encryption');
      return null;
    }
  }, [client, canDeriveKey, deriveKey]);

  /**
   * Refresh the list of all E2E encrypted answers (from both private and allowlist collections)
   */
  const refresh = useCallback(async () => {
    console.log('[Vault] refresh() called, user:', user?.fid, 'canDeriveKey:', canDeriveKey);
    
    if (!user?.fid) {
      console.log('[Vault] No user, aborting');
      setError('Must be authenticated');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      console.log('[Vault] Getting client...');
      const activeClient = await ensureClient();
      if (!activeClient) {
        console.log('[Vault] No active client returned');
        return;
      }
      console.log('[Vault] Got client');

      console.log('[Vault] Collection IDs - private:', privateCollectionId, 'allowlist:', allowlistCollectionId);
      if (!privateCollectionId && !allowlistCollectionId) {
        throw new Error('Collection IDs not configured');
      }

      // Fetch from both collections in parallel
      console.log('[Vault] Fetching from collections...');
      const [privateAnswers, allowlistAnswers] = await Promise.all([
        privateCollectionId ? listOwnAnswers(activeClient, privateCollectionId) : [],
        allowlistCollectionId ? listOwnAnswers(activeClient, allowlistCollectionId) : [],
      ]);

      console.log('[Vault] Got answers - private:', privateAnswers.length, 'allowlist:', allowlistAnswers.length);

      // Combine and sort by created_at
      const allAnswers = [...privateAnswers, ...allowlistAnswers].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      
      setAnswers(allAnswers);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load answers';
      setError(message);
      console.error('[Vault] Error loading E2E answers:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user?.fid, canDeriveKey, ensureClient, privateCollectionId, allowlistCollectionId]);

  /**
   * Get answers for a specific question (from both private and allowlist collections)
   */
  const getAnswersForQuestion = useCallback(async (questionId: string): Promise<StoredPrivateAnswer[]> => {
    if (!user?.fid) {
      setError('Must be authenticated');
      return [];
    }

    try {
      const activeClient = await ensureClient();
      if (!activeClient) return [];

      if (!privateCollectionId && !allowlistCollectionId) {
        throw new Error('Collection IDs not configured');
      }

      // Fetch from both collections in parallel
      const [privateAnswers, allowlistAnswers] = await Promise.all([
        privateCollectionId ? listOwnAnswersForQuestion(activeClient, privateCollectionId, questionId) : [],
        allowlistCollectionId ? listOwnAnswersForQuestion(activeClient, allowlistCollectionId, questionId) : [],
      ]);

      return [...privateAnswers, ...allowlistAnswers];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load answers';
      setError(message);
      console.error('Error loading E2E answers for question:', err);
      return [];
    }
  }, [user?.fid, ensureClient, privateCollectionId, allowlistCollectionId]);

  /**
   * Read a single answer by ID
   * @param answerId - The answer ID
   * @param audience - 'Private' or 'Allowlist' to determine which collection to read from
   */
  const readAnswer = useCallback(async (answerId: string, audience: 'Private' | 'Allowlist' = 'Private'): Promise<StoredPrivateAnswer | null> => {
    if (!user?.fid) {
      setError('Must be authenticated');
      return null;
    }

    try {
      const activeClient = await ensureClient();
      if (!activeClient) return null;

      const collectionId = audience === 'Private' ? privateCollectionId : allowlistCollectionId;
      if (!collectionId) {
        throw new Error(`${audience} collection ID not configured`);
      }

      return await readOwnPrivateAnswer(activeClient, collectionId, answerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read answer';
      setError(message);
      console.error('Error reading E2E answer:', err);
      return null;
    }
  }, [user?.fid, ensureClient, privateCollectionId, allowlistCollectionId]);

  return {
    answers,
    isLoading,
    error,
    refresh,
    getAnswersForQuestion,
    readAnswer,
    // canRead requires: authenticated + can derive key + at least one collection ID loaded
    canRead: !!user?.fid && canDeriveKey && !!(privateCollectionId || allowlistCollectionId),
    needsWalletConnection: !!user?.fid && !isWalletConnected,
    needsKeyDerivation: !!user?.fid && isWalletConnected && !derivedSeed,
    client,
    privateCollectionId,
    allowlistCollectionId,
  };
}

export default usePrivateAnswerRead;

/**
 * Combined hook for fetching user's answer including E2E encrypted answers.
 * 
 * This merges:
 * - Server API answers (Public, server-encrypted Private/Allowlist/Anon)
 * - E2E encrypted answers (browser-decrypted from Nillion owned collection)
 * 
 * Use this in components that need to display all user answers including E2E.
 */
export function useUserAnswerWithE2E(
  userId: number | undefined,
  questionId: string | undefined
) {
  const { getAnswersForQuestion, canRead, needsWalletConnection, needsKeyDerivation } = usePrivateAnswerRead();
  const [e2eAnswers, setE2eAnswers] = useState<StoredPrivateAnswer[]>([]);
  const [isLoadingE2E, setIsLoadingE2E] = useState(false);
  const [e2eError, setE2eError] = useState<string | null>(null);

  // Fetch E2E answers when we can read
  useEffect(() => {
    if (!userId || !questionId || !canRead) {
      setE2eAnswers([]);
      return;
    }

    setIsLoadingE2E(true);
    setE2eError(null);

    getAnswersForQuestion(questionId)
      .then(answers => {
        setE2eAnswers(answers);
      })
      .catch(err => {
        console.error('Failed to fetch E2E answers:', err);
        setE2eError(err instanceof Error ? err.message : 'Failed to load E2E answers');
      })
      .finally(() => {
        setIsLoadingE2E(false);
      });
  }, [userId, questionId, canRead, getAnswersForQuestion]);

  // Convert E2E answers to the Answer format expected by components
  const e2eAnswersAsStandard = e2eAnswers.map(answer => ({
    id: answer._id,
    q_id: answer.q_id,
    user_id: answer.user_id,
    value: answer.value,
    answer_type_id: answer.answer_type_id,
    audience: answer.audience,
    created_at: answer.created_at,
    updated_at: answer.updated_at,
    primary_type: answer.primary_type,
    q_index: answer.q_index,
    is_deleted: answer.is_deleted,
    encryption_version: answer.encryption_version || 'v2',
    // E2E answers are always from Nillion owned collection
    source: 'e2e' as const,
  }));

  return {
    e2eAnswers: e2eAnswersAsStandard,
    isLoadingE2E,
    e2eError,
    canReadE2E: canRead,
    needsWalletConnection,
    needsKeyDerivation,
  };
}

