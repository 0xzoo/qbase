/**
 * Browser-side Nillion Client
 * 
 * Uses SecretVaultUserClient for client-side encryption.
 * The user's wallet-derived keypair does the encryption - 
 * the server never sees plaintext private answers.
 * 
 * This is the E2E encryption path that bypasses server-side encryption.
 */

// Note: These imports require the Nillion SDK to be properly polyfilled
// See vite.config.ts for the node polyfills configuration
import type { SecretVaultUserClient } from '@nillion/secretvaults';

// Nillion network configuration (testnet)
const NILLION_CONFIG = {
  baseUrls: [
    'https://nildb-stg-n1.nillion.network',
    'https://nildb-stg-n2.nillion.network',
    'https://nildb-stg-n3.nillion.network',
  ],
};

/**
 * Create a Nillion user client with the user's wallet-derived keypair.
 * This client encrypts data client-side before sending to Nillion.
 * 
 * @param privateKeySeed - 32-byte hex seed derived from wallet signature
 * @returns Authenticated SecretVaultUserClient
 */
export async function createUserNillionClient(
  privateKeySeed: string
): Promise<SecretVaultUserClient> {
  // Dynamic import to avoid SSR issues and allow proper polyfilling
  const { SecretVaultUserClient } = await import('@nillion/secretvaults');
  const { Signer } = await import('@nillion/nuc');

  // Create signer from wallet-derived seed
  const signer = Signer.fromPrivateKey(privateKeySeed);
  
  // Initialize user client with blindfold for client-side encryption
  const client = await SecretVaultUserClient.from({
    signer,
    baseUrls: NILLION_CONFIG.baseUrls,
    blindfold: { operation: 'store' },
  });
  
  return client;
}

/**
 * Get the user's DID (Decentralized Identifier) from their keypair.
 * This DID is used for access control in Nillion.
 */
export async function getUserDid(privateKeySeed: string): Promise<string> {
  const { Signer } = await import('@nillion/nuc');
  const signer = Signer.fromPrivateKey(privateKeySeed);
  const did = await signer.getDid();
  return did.toString();
}

/**
 * Data structure for storing a private answer
 */
export interface PrivateAnswerData {
  q_id: string;
  value: string;
  answer_type_id: string;
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge';
  q_index?: number;
}

/**
 * Result from storing a private answer
 */
export interface StorePrivateAnswerResult {
  answerId: string;
  success: boolean;
}

/**
 * Store a private answer with E2E encryption.
 * 
 * The data is encrypted client-side by the user's keypair before
 * being sent to Nillion. The server never sees plaintext.
 * 
 * @param client - Authenticated SecretVaultUserClient
 * @param data - Answer data to encrypt and store
 * @param delegationToken - Delegation token from server
 * @param collectionId - Nillion collection ID for private answers
 * @param userId - User's FID
 */
export async function storePrivateAnswerE2E(
  client: SecretVaultUserClient,
  data: PrivateAnswerData,
  delegationToken: string,
  collectionId: string,
  userId: number,
): Promise<StorePrivateAnswerResult> {
  const answerId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  // Get the user's DID from the client
  const userDid = await client.getId();
  
  // Build answer record
  const answerRecord: Record<string, unknown> = {
    _id: answerId,
    q_id: data.q_id,
    user_id: userId,
    value: data.value,
    answer_type_id: data.answer_type_id,
    audience: 'Private',
    created_at: now,
    primary_type: data.primary_type,
    encryption_version: 'v2', // Mark as E2E encrypted
  };

  // Add type-specific fields
  if (data.primary_type === 'identity' || data.primary_type === 'prospective') {
    answerRecord.updated_at = now;
  } else if (data.primary_type === 'recurring') {
    answerRecord.is_deleted = false;
  }

  // Add q_index for multiple choice/scale answers
  if (data.q_index !== undefined) {
    answerRecord.q_index = data.q_index;
  }

  // Store with E2E encryption using createData
  // The blindfold configuration encrypts marked fields client-side
  const result = await client.createData(
    {
      owner: userDid,
      collection: collectionId,
      data: [answerRecord],
      acl: {
        grantee: userDid, // Only the owner can access
        read: true,
        write: true,
        execute: false,
      },
    },
    {
      // Pass delegation token for authorization
      auth: { delegation: delegationToken },
    }
  );

  return {
    answerId,
    success: !!result,
  };
}

/**
 * Stored answer structure returned from Nillion
 */
export interface StoredPrivateAnswer {
  _id: string;
  q_id: string;
  user_id: number;
  value: string;
  answer_type_id: string;
  audience: 'Private' | 'Allowlist';
  created_at: string;
  updated_at?: string;
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge';
  encryption_version?: string;
  q_index?: number;
  is_deleted?: boolean;
}

/**
 * List all private/allowlist answers owned by the user.
 * 
 * @param client - Authenticated SecretVaultUserClient
 * @param collectionId - Nillion collection ID for user-owned answers
 * @returns Array of answer references with metadata
 */
export async function listOwnAnswers(
  client: SecretVaultUserClient,
  collectionId: string,
): Promise<StoredPrivateAnswer[]> {
  try {
    // Get user's DID for debugging
    const userDid = await client.getId();
    console.log('[Nillion] Listing answers for DID:', userDid);
    console.log('[Nillion] Collection ID:', collectionId);
    
    // List all data references owned by this user
    const result = await client.listDataReferences();
    
    console.log('[Nillion] listDataReferences result:', JSON.stringify(result, null, 2));
    
    if (!result?.data) {
      console.log('[Nillion] No data property in result');
      return [];
    }

    console.log('[Nillion] Found', result.data.length, 'data references');

    // The result contains references, we need to read each document
    const answers: StoredPrivateAnswer[] = [];
    
    // Filter to only the target collection and read each document
    for (const ref of result.data) {
      console.log('[Nillion] Processing ref:', JSON.stringify(ref, null, 2));
      
      // Check if this reference is from our collection
      // The reference structure may vary, handle both formats
      const refCollection = typeof ref === 'object' && ref !== null 
        ? (ref as Record<string, unknown>).collection 
        : null;
      
      if (refCollection === collectionId || !refCollection) {
        const docId = typeof ref === 'object' && ref !== null
          ? (ref as Record<string, unknown>)._id || (ref as Record<string, unknown>).id
          : ref;
        
        if (docId && typeof docId === 'string') {
          try {
            console.log('[Nillion] Reading document:', docId);
            const doc = await readOwnPrivateAnswer(client, collectionId, docId);
            if (doc) {
              answers.push(doc as StoredPrivateAnswer);
            }
          } catch (readError) {
            console.warn(`[Nillion] Failed to read document ${docId}:`, readError);
          }
        }
      }
    }

    console.log('[Nillion] Returning', answers.length, 'answers');
    return answers;
  } catch (error) {
    console.error('[Nillion] Failed to list own answers:', error);
    return [];
  }
}

/**
 * List answers for a specific question owned by the user.
 * 
 * @param client - Authenticated SecretVaultUserClient
 * @param collectionId - Nillion collection ID
 * @param questionId - Question ID to filter by
 */
export async function listOwnAnswersForQuestion(
  client: SecretVaultUserClient,
  collectionId: string,
  questionId: string,
): Promise<StoredPrivateAnswer[]> {
  const allAnswers = await listOwnAnswers(client, collectionId);
  return allAnswers.filter(answer => answer.q_id === questionId);
}

/**
 * Read a user's own private answer.
 * 
 * @param client - Authenticated SecretVaultUserClient  
 * @param collectionId - Nillion collection ID
 * @param documentId - Document ID to read
 */
export async function readOwnPrivateAnswer(
  client: SecretVaultUserClient,
  collectionId: string,
  documentId: string,
): Promise<StoredPrivateAnswer | null> {
  try {
    const result = await client.readData({
      collection: collectionId,
      document: documentId,
    });

    // Return the document if found
    // The Nillion SDK returns additional metadata fields (_created, _updated, etc.)
    // We cast through unknown to extract our answer data
    const data = result?.data;
    if (data && typeof data === 'object' && '_id' in data) {
      // Extract the answer fields from the response
      const record = data as Record<string, unknown>;
      return {
        _id: record._id as string,
        q_id: record.q_id as string,
        user_id: record.user_id as number,
        value: record.value as string,
        answer_type_id: record.answer_type_id as string,
        audience: record.audience as 'Private' | 'Allowlist',
        created_at: record.created_at as string,
        primary_type: record.primary_type as 'identity' | 'recurring' | 'prospective' | 'knowledge',
        updated_at: record.updated_at as string | undefined,
        encryption_version: record.encryption_version as string | undefined,
        q_index: record.q_index as number | undefined,
        is_deleted: record.is_deleted as boolean | undefined,
      };
    }
    return null;
  } catch (error) {
    console.error('Failed to read private answer:', error);
    return null;
  }
}

/**
 * Delete a private answer.
 * Only the owner can delete their own data.
 */
export async function deletePrivateAnswer(
  client: SecretVaultUserClient,
  collectionId: string,
  answerId: string,
): Promise<boolean> {
  try {
    await client.deleteData({
      collection: collectionId,
      document: answerId,
    });
    return true;
  } catch (error) {
    console.error('Failed to delete private answer:', error);
    return false;
  }
}

export { NILLION_CONFIG };
