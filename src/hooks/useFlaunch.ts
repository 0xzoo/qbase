import { useState, useEffect, useMemo } from 'react';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import type { PublicClient, WalletClient, Address, Transport } from 'viem';
import { base } from 'viem/chains';
import { createFlaunch, ReadWriteFlaunchSDK, ReadFlaunchSDK } from '@flaunch/sdk';

export interface UseFlaunchResult {
  flaunchRead: ReadFlaunchSDK;
  flaunchWrite: ReadWriteFlaunchSDK | null;
  publicClient: PublicClient<Transport, typeof base>;
  walletClient: WalletClient | null;
  address: Address | null;
  isConnected: boolean;
  isConnecting: boolean;
  connectWallet: () => Promise<void>;
  error: string | null;
}

export const useFlaunch = (): UseFlaunchResult => {
  const [address, setAddress] = useState<Address | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize Public Client (Always available)
  const publicClient = useMemo(() => {
    return createPublicClient({
      chain: base,
      transport: http(), // Uses default public RPC
    });
  }, []);

  // Initialize Read-Only SDK
  const flaunchRead = useMemo(() => {
    // Cast to unknown then to expected type to avoid viem version mismatch issues between dependencies
    return createFlaunch({ publicClient: publicClient as unknown as Parameters<typeof createFlaunch>[0]['publicClient'] });
  }, [publicClient]);

  // Initialize Read-Write SDK (Only when wallet is connected)
  const flaunchWrite = useMemo(() => {
    if (!walletClient) return null;
    return createFlaunch({
      publicClient: publicClient as unknown as Parameters<typeof createFlaunch>[0]['publicClient'],
      walletClient: walletClient as unknown as Parameters<typeof createFlaunch>[0]['walletClient'],
    }) as ReadWriteFlaunchSDK;
  }, [publicClient, walletClient]);

  // Connect Wallet Function
  const connectWallet = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      if (typeof window === 'undefined' || !(window as unknown as { ethereum?: unknown }).ethereum) {
        throw new Error('No wallet found. Please install MetaMask or use a crypto-enabled browser.');
      }

      const client = createWalletClient({
        chain: base,
        transport: custom((window as unknown as { ethereum: unknown }).ethereum),
      }) as WalletClient;

      const [account] = await client.requestAddresses();

      if (account) {
        setAddress(account);
        setWalletClient(client);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to connect wallet:', err);
      setError(error.message || 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  };

  // Auto-connect if already authorized (optional, but good UX)
  useEffect(() => {
    const checkConnection = async () => {
      if (typeof window !== 'undefined' && (window as unknown as { ethereum?: unknown }).ethereum) {
        try {
          const client = createWalletClient({
            chain: base,
            transport: custom((window as unknown as { ethereum: unknown }).ethereum),
          });
          // This might prompt if not connected, maybe use getAddresses if available or just wait for user action
          // Actually, requestAddresses will prompt. We should probably NOT auto-connect unless we know we can.
          // For now, let's rely on explicit connect, or maybe check 'eth_accounts' which doesn't prompt.

          // Better approach for auto-connect without prompt:
          const permissions = await (window as unknown as { ethereum: { request: (args: { method: string }) => Promise<string[]> } }).ethereum.request({ method: 'eth_accounts' });
          if (permissions && permissions.length > 0) {
            setAddress(permissions[0]);
            setWalletClient(client);
          }
        } catch {
          // Ignore error on auto-check
        }
      }
    };

    checkConnection();
  }, []);

  return {
    flaunchRead,
    flaunchWrite,
    publicClient,
    walletClient,
    address,
    isConnected: !!address && !!walletClient,
    isConnecting,
    connectWallet,
    error,
  };
};
