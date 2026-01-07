/**
 * Wagmi Configuration
 * 
 * Configures wallet connections for both:
 * - Farcaster MiniApp (Warpcast wallet)
 * - Browser wallets (MetaMask, Rainbow, etc.)
 */

import { createConfig, http } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector';
import { injected } from 'wagmi/connectors';

export const wagmiConfig = createConfig({
  chains: [base, mainnet],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
  },
  connectors: [
    // Farcaster MiniApp connector (for Warpcast)
    farcasterMiniApp(),
    // Browser extension wallets (MetaMask, Rainbow, etc.)
    injected(),
  ],
});

// Re-export chains for convenience
export { base, mainnet };

