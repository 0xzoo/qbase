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

import { useState, useCallback, useEffect } from 'react';
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

// Get collection ID from env
const USER_OWNED_COLLECTION_ID = import.meta.env.VITE_NILLION_USER_OWNED_ANSWER_SCHEMA_ID as string;

interface UsePrivateAnswerReadReturn {
  /** All user's E2E encrypted answers */
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
  readAnswer: (answerId: string) => Promise<StoredPrivateAnswer | null>;
  /** Whether the user can read (authenticated + wallet connected) */
  canRead: boolean;
  /** Whether wallet needs to be connected first */
  needsWalletConnection: boolean;
  /** Whether key derivation is needed (will prompt wallet signature) */
  needsKeyDerivation: boolean;
  /** The Nillion client (if initialized) */
  client: SecretVaultUserClient | null;
}

export function usePrivateAnswerRead(): UsePrivateAnswerReadReturn {
  const { user } = useAuth();
  const { deriveKey, derivedSeed, canDeriveKey, isWalletConnected } = useNillionKey();
  
  const [answers, setAnswers] = useState<StoredPrivateAnswer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<SecretVaultUserClient | null>(null);

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
   * Refresh the list of all E2E encrypted answers
   */
  const refresh = useCallback(async () => {
    if (!user?.fid) {
      setError('Must be authenticated');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const activeClient = await ensureClient();
      if (!activeClient) return;

      if (!USER_OWNED_COLLECTION_ID) {
        throw new Error('Collection ID not configured');
      }

      const fetchedAnswers = await listOwnAnswers(activeClient, USER_OWNED_COLLECTION_ID);
      setAnswers(fetchedAnswers);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load answers';
      setError(message);
      console.error('Error loading E2E answers:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user?.fid, ensureClient]);

  /**
   * Get answers for a specific question
   */
  const getAnswersForQuestion = useCallback(async (questionId: string): Promise<StoredPrivateAnswer[]> => {
    if (!user?.fid) {
      setError('Must be authenticated');
      return [];
    }

    try {
      const activeClient = await ensureClient();
      if (!activeClient) return [];

      if (!USER_OWNED_COLLECTION_ID) {
        throw new Error('Collection ID not configured');
      }

      return await listOwnAnswersForQuestion(activeClient, USER_OWNED_COLLECTION_ID, questionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load answers';
      setError(message);
      console.error('Error loading E2E answers for question:', err);
      return [];
    }
  }, [user?.fid, ensureClient]);

  /**
   * Read a single answer by ID
   */
  const readAnswer = useCallback(async (answerId: string): Promise<StoredPrivateAnswer | null> => {
    if (!user?.fid) {
      setError('Must be authenticated');
      return null;
    }

    try {
      const activeClient = await ensureClient();
      if (!activeClient) return null;

      if (!USER_OWNED_COLLECTION_ID) {
        throw new Error('Collection ID not configured');
      }

      return await readOwnPrivateAnswer(activeClient, USER_OWNED_COLLECTION_ID, answerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read answer';
      setError(message);
      console.error('Error reading E2E answer:', err);
      return null;
    }
  }, [user?.fid, ensureClient]);

  return {
    answers,
    isLoading,
    error,
    refresh,
    getAnswersForQuestion,
    readAnswer,
    canRead: !!user?.fid && canDeriveKey,
    needsWalletConnection: !!user?.fid && !isWalletConnected,
    needsKeyDerivation: !!user?.fid && isWalletConnected && !derivedSeed,
    client,
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

