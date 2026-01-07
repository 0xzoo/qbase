/**
 * Wallet Context Provider
 * 
 * Wraps the app with Wagmi provider for wallet connections.
 * Works with both Farcaster MiniApp and browser wallets.
 */

import React from 'react';
import { WagmiProvider } from 'wagmi';
import { wagmiConfig } from '../lib/wagmi';

interface WalletProviderProps {
  children: React.ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      {children}
    </WagmiProvider>
  );
}

export default WalletProvider;

