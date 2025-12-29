import { SecretVaultBuilderClient } from '@nillion/secretvaults';
import { Signer, NilauthClient } from '@nillion/nuc';

interface Env {
  NILLION_ORG_DID: string;
  NILLION_ORG_KEY: string;
  NILLION_NODES: string;
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: string;
  NILLION_ANON_ANSWER_SCHEMA_ID: string;
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: string;
  NILAUTH_URL?: string; // Optional Nilauth URL
}

export async function getNillionClient(env: Env) {
  // Parse nodes from environment
  let nodeUrls: string[];
  try {
    const nodesStr = env.NILLION_NODES || '[]';

    // Handle both string and already-parsed array
    let nodesData: unknown;
    if (typeof nodesStr === 'string') {
      nodesData = JSON.parse(nodesStr);
    } else if (Array.isArray(nodesStr)) {
      nodesData = nodesStr;
    } else {
      throw new Error(`NILLION_NODES has unexpected type: ${typeof nodesStr}`);
    }

    if (!Array.isArray(nodesData) || nodesData.length === 0) {
      throw new Error('NILLION_NODES must be a non-empty array');
    }

    // Extract URLs from node objects (they have {url, did} structure)
    nodeUrls = nodesData.map((node: unknown) => {
      if (typeof node === 'string') {
        return node; // Already a URL string
      } else if (node && typeof node === 'object' && 'url' in node && typeof (node as { url: unknown }).url === 'string') {
        return (node as { url: string }).url; // Extract url from object
      } else {
        throw new Error('Invalid node format - expected string or object with url field');
      }
    });

    console.log('Node URLs:', nodeUrls);
  } catch (e: unknown) {
    const err = e as { message?: string };
    throw new Error(`Failed to parse NILLION_NODES: ${err.message}`);
  }

  // Create signer from the private key (hex string)
  const signer = Signer.fromPrivateKey(env.NILLION_ORG_KEY);

  // Create NilauthClient using the factory method
  // Uses sandbox URL by default (matching docs)
  const nilauthUrl = env.NILAUTH_URL || 'https://nilauth.sandbox.app-cluster.sandbox.nilogy.xyz';
  
  try {
    const nilauthClient = await NilauthClient.create({
      baseUrl: nilauthUrl,
    });

    // Initialize the builder client with correct parameters
    const client = await SecretVaultBuilderClient.from({
      signer,
      nilauthClient,
      dbs: nodeUrls,
      blindfold: {
        operation: 'store' as const,
      },
    });

    // Refresh root token to authenticate with the nodes
    try {
      await client.refreshRootToken();
    } catch (tokenError: unknown) {
      const err = tokenError as { message?: string; status?: number; statusCode?: number };
      if (err.status === 412 || err.statusCode === 412) {
        throw new Error(
          'Nillion subscription not activated. Please activate your subscription at https://nillion.pub\n' +
          `Error: ${err.message || 'Precondition Failed (412)'}`
        );
      }
      throw new Error(
        `Failed to authenticate with Nillion nodes: ${err.message || 'Unknown error'}\n` +
        `Nilauth URL: ${nilauthUrl}\n` +
        `Node URLs: ${nodeUrls.join(', ')}`
      );
    }

    return client;
  } catch (error: unknown) {
    const err = error as { message?: string; status?: number; statusCode?: number; cause?: unknown };
    
    // Check if it's a network/connection error
    if (err.message?.includes('Failed to reach') || err.message?.includes('ECONNREFUSED') || err.message?.includes('ENOTFOUND')) {
      throw new Error(
        `Cannot connect to Nillion Nilauth service at ${nilauthUrl}\n` +
        `This could be due to:\n` +
        `  1. Network connectivity issues\n` +
        `  2. Nillion service temporarily unavailable\n` +
        `  3. Firewall blocking the connection\n` +
        `  4. Incorrect NILAUTH_URL in your configuration\n\n` +
        `Please check:\n` +
        `  - Your internet connection\n` +
        `  - Nillion service status\n` +
        `  - Your NILAUTH_URL setting (currently: ${nilauthUrl})\n` +
        `  - Try accessing ${nilauthUrl} in your browser\n\n` +
        `Original error: ${err.message}`
      );
    }
    
    // Re-throw with more context
    throw new Error(
      `Nillion client initialization failed: ${err.message || 'Unknown error'}\n` +
      `Nilauth URL: ${nilauthUrl}\n` +
      `Node URLs: ${nodeUrls.join(', ')}`
    );
  }
}

export async function storePrivateAnswer(
  client: SecretVaultBuilderClient,
  answerData: Record<string, unknown>,
  schemaId: string
) {
  // createStandardData expects an object with 'collection' and 'data' fields
  const result = await client.createStandardData({
    collection: schemaId,
    data: [answerData],
  });
  return result;
}

export async function getPrivateAnswers(
  client: SecretVaultBuilderClient,
  schemaId: string,
  filter: Record<string, unknown> = {}
) {
  // findData expects an object with 'collection' and 'filter' fields
  const result = await client.findData({
    collection: schemaId,
    filter,
  });

  // With blindfold configured, encrypted fields are automatically decrypted
  return result;
}
