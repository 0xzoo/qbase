import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

export interface SignerInfo {
  signer_uuid: string;
  public_key: string;
  status: 'pending_approval' | 'approved' | 'revoked';
  created_at: string;
}

interface UseSignerResult {
  /** The user's approved signer, if any */
  signer: SignerInfo | null;
  /** True while checking signer status */
  isLoading: boolean;
  /** True if user has an approved signer */
  hasApprovedSigner: boolean;
  /** Create a new signer. Returns the approval URL. */
  createSigner: () => Promise<{ approvalUrl: string; signerUuid: string }>;
  /** Poll until signer is approved (or timeout) */
  pollUntilApproved: (signerUuid: string, timeoutMs?: number) => Promise<boolean>;
  /** Refetch signer list */
  refetch: () => void;
  /** Error message, if any */
  error: string | null;
}

export function useSigner(): UseSignerResult {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [signer, setSigner] = useState<SignerInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSigners = useCallback(async () => {
    if (!isAuthenticated) {
      setSigner(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const token = getAuthToken();
      const res = await fetch('/api/farcaster/signer/list', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch signers: ${res.status}`);
      }

      const data = await res.json() as { signers: SignerInfo[] };
      // Find the first approved signer, or the most recent pending one
      const approved = data.signers.find(s => s.status === 'approved');
      const pending = data.signers.find(s => s.status === 'pending_approval');
      setSigner(approved || pending || null);
    } catch (e: any) {
      console.error('[useSigner] Error fetching signers:', e);
      setError(e.message);
      setSigner(null);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, getAuthToken]);

  useEffect(() => {
    fetchSigners();
  }, [fetchSigners]);

  const createSigner = useCallback(async () => {
    const token = getAuthToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch('/api/farcaster/signer/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to create signer: ${res.status}`);
    }

    const data = await res.json() as {
      signer_uuid: string;
      public_key: string;
      status: string;
      approval_url: string;
    };

    // Update local state to show pending signer
    setSigner({
      signer_uuid: data.signer_uuid,
      public_key: data.public_key,
      status: 'pending_approval',
      created_at: new Date().toISOString(),
    });

    return {
      approvalUrl: data.approval_url,
      signerUuid: data.signer_uuid,
    };
  }, [getAuthToken]);

  const pollUntilApproved = useCallback(async (signerUuid: string, timeoutMs = 120_000): Promise<boolean> => {
    const start = Date.now();
    const pollInterval = 3000;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`/api/farcaster/signer/status?signer_uuid=${encodeURIComponent(signerUuid)}`);
        if (res.ok) {
          const data = await res.json() as { status: string; fid?: number };
          if (data.status === 'approved') {
            // Update local state
            setSigner(prev => prev && prev.signer_uuid === signerUuid
              ? { ...prev, status: 'approved' }
              : prev
            );
            return true;
          }
          if (data.status === 'revoked') {
            return false;
          }
        }
      } catch (e) {
        console.warn('[useSigner] Poll error:', e);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return false; // timed out
  }, []);

  return {
    signer,
    isLoading,
    hasApprovedSigner: signer?.status === 'approved',
    createSigner,
    pollUntilApproved,
    refetch: fetchSigners,
    error,
  };
}
