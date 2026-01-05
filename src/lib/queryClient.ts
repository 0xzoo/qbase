import { QueryClient } from '@tanstack/react-query';

/**
 * Query client configuration with:
 * - Exponential backoff retry logic (3 attempts: 1s, 2s, 4s delays)
 * - Stale-while-revalidate patterns (staleTime: 30s, gcTime: 5min)
 * - Smart refetch behavior (on window focus, reconnect)
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Stale-while-revalidate: Show cached data immediately, refetch in background
      staleTime: 30 * 1000, // 30 seconds - data considered fresh
      gcTime: 5 * 60 * 1000, // 5 minutes - cache garbage collection
      
      // Retry logic with exponential backoff
      retry: (failureCount, error) => {
        // Don't retry on 4xx errors (client errors)
        if (error instanceof Error && 'status' in error) {
          const status = (error as Error & { status: number }).status;
          if (status >= 400 && status < 500) {
            return false;
          }
        }
        // Retry up to 3 times for other errors
        return failureCount < 3;
      },
      retryDelay: (attemptIndex) => {
        // Exponential backoff: 1s, 2s, 4s
        return Math.min(1000 * 2 ** attemptIndex, 8000);
      },
      
      // Refetch behavior
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
    },
    mutations: {
      // Retry mutations only once (to avoid duplicate submissions)
      retry: 1,
      retryDelay: 1000,
    },
  },
});

// Query key factories for consistent cache key generation
export const queryKeys = {
  // Settings
  settings: (fid: number | undefined) => ['settings', fid] as const,
  
  // Questions/Queries
  questions: {
    all: ['questions'] as const,
    list: (filters: { limit?: number; offset?: number; sort?: string }) => 
      ['questions', 'list', filters] as const,
    detail: (id: string) => ['questions', 'detail', id] as const,
    search: (query: string) => ['questions', 'search', query] as const,
  },
  
  // Answers
  answers: {
    all: ['answers'] as const,
    forQuery: (queryId: string, filters?: { limit?: number; offset?: number; audience?: string }) => 
      ['answers', 'forQuery', queryId, filters] as const,
    detail: (id: string) => ['answers', 'detail', id] as const,
    userForQuestion: (userId: number, queryId: string) => 
      ['answers', 'userForQuestion', userId, queryId] as const,
    userAll: (userId: number) => ['answers', 'user', userId] as const,
  },
  
  // User
  user: {
    profile: (fid: number) => ['user', 'profile', fid] as const,
    signers: (fid: number) => ['user', 'signers', fid] as const,
  },
} as const;

