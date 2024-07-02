import { http, createConfig } from '@wagmi/core'
import { baseSepolia } from '@wagmi/core/chains'
import { coinbaseWallet } from '@wagmi/connectors'

export const config = createConfig({
  chains: [baseSepolia],
  connectors: [
    coinbaseWallet({
      appName: 'qbase',
      preference: 'smartWalletOnly',
    }),
  ],
  transports: {
    [baseSepolia.id]: http(),
  },
})