import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { queryClient } from './lib/queryClient'
import { WalletProvider } from './context/WalletContext'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <WagmiQueryProvider>
    <App />
    <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
  </WagmiQueryProvider>
)

/**
 * Combined provider that ensures correct ordering:
 * WalletProvider (Wagmi) -> QueryClientProvider (React Query)
 * 
 * Note: Wagmi internally uses React Query, but we use our own QueryClient
 * for app-level queries. The WalletProvider doesn't conflict with this.
 */
function WagmiQueryProvider({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WalletProvider>
  );
}
