import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { apiClient } from '../lib/apiClient';
import { queryKeys } from '../lib/queryClient';
import type { Query } from '../lib/types';

interface QuestionsResponse {
  results: Query[];
  limit: number;
  offset: number;
}

interface UseQuestionsOptions {
  limit?: number;
  offset?: number;
  sort?: 'new' | 'popular';
  enableInfiniteScroll?: boolean;
  enabled?: boolean; // If false, skip the query entirely
}

// API function
async function fetchQuestions(params: { limit: number; offset: number; sort: string }): Promise<QuestionsResponse> {
  const response = await apiClient.get(
    `/api/queries?limit=${params.limit}&offset=${params.offset}&sort=${params.sort}`
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch questions: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Hook for fetching questions with React Query
 * 
 * Features:
 * - Stale-while-revalidate for instant UI with background refresh
 * - Automatic retry with exponential backoff
 * - Infinite scroll support via useInfiniteQuery
 * - Cache invalidation utilities
 */
export function useQuestions(options: UseQuestionsOptions = {}) {
  const { limit = 20, offset = 0, sort = 'new', enableInfiniteScroll = false, enabled = true } = options;
  const queryClient = useQueryClient();

  // Use infinite query for pagination support
  const infiniteQuery = useInfiniteQuery({
    queryKey: queryKeys.questions.list({ limit, sort }),
    queryFn: ({ pageParam = 0 }) => fetchQuestions({ limit, offset: pageParam, sort }),
    initialPageParam: offset,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      // If we got fewer results than requested, we're at the end
      if (lastPage.results.length < limit) {
        return undefined;
      }
      return lastPageParam + lastPage.results.length;
    },
    enabled: enabled && enableInfiniteScroll,
    staleTime: 30 * 1000, // 30 seconds
  });

  // Use regular query for non-infinite scroll
  const regularQuery = useQuery({
    queryKey: queryKeys.questions.list({ limit, offset, sort }),
    queryFn: () => fetchQuestions({ limit, offset, sort }),
    enabled: enabled && !enableInfiniteScroll,
    staleTime: 30 * 1000, // 30 seconds
  });

  // Combine pages into flat array for infinite scroll
  const infiniteQuestions = infiniteQuery.data?.pages.flatMap(page => page.results) ?? [];
  
  // Determine which query to use
  const query = enableInfiniteScroll ? infiniteQuery : regularQuery;
  const questions = enableInfiniteScroll 
    ? infiniteQuestions 
    : (regularQuery.data?.results ?? []);

  return {
    questions,
    loading: query.isLoading,
    loadingMore: infiniteQuery.isFetchingNextPage,
    error: query.error?.message ?? null,
    hasMore: enableInfiniteScroll ? infiniteQuery.hasNextPage : false,
    loadMore: () => {
      if (enableInfiniteScroll && infiniteQuery.hasNextPage && !infiniteQuery.isFetchingNextPage) {
        infiniteQuery.fetchNextPage();
      }
    },
    refetch: () => {
      if (enableInfiniteScroll) {
        // Reset infinite query to first page
        queryClient.resetQueries({ queryKey: queryKeys.questions.list({ limit, sort }) });
        infiniteQuery.refetch();
      } else {
        regularQuery.refetch();
      }
    },
    // Additional React Query utilities
    isStale: query.isStale,
    isFetching: query.isFetching,
  };
}

/**
 * Hook for fetching a single question by ID
 */
export function useQuestion(id: string | undefined, pollId?: string) {
  const query = useQuery({
    // A wave named in the URL (?poll=) changes which wave the payload answers
    // through, so it is part of the cache key.
    queryKey: [...queryKeys.questions.detail(id ?? ''), pollId ?? 'open'],
    queryFn: async () => {
      const response = await apiClient.get(`/api/queries/${id}${pollId ? `?poll=${encodeURIComponent(pollId)}` : ''}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Question not found');
        }
        throw new Error(`Failed to fetch question: ${response.statusText}`);
      }

      return response.json() as Promise<Query>;
    },
    enabled: !!id,
    staleTime: 60 * 1000, // 1 minute - individual questions change less frequently
  });

  return {
    question: query.data ?? null,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    refetch: query.refetch,
    isFetching: query.isFetching,
  };
}

/**
 * Utility hook for invalidating question-related caches
 * 
 * IMPORTANT: All functions are memoized to prevent unnecessary re-renders
 * and infinite loops when used in useEffect dependency arrays.
 */
export function useQuestionCacheUtils() {
  const queryClient = useQueryClient();

  const invalidateAll = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.questions.all }),
    [queryClient]
  );

  const invalidateList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['questions', 'list'] }),
    [queryClient]
  );

  const invalidateQuestion = useCallback(
    (id: string) => queryClient.invalidateQueries({ queryKey: queryKeys.questions.detail(id) }),
    [queryClient]
  );

  const prefetchQuestion = useCallback(
    async (id: string) => {
      await queryClient.prefetchQuery({
        queryKey: queryKeys.questions.detail(id),
        queryFn: async () => {
          const response = await apiClient.get(`/api/queries/${id}`);
          if (!response.ok) throw new Error('Failed to prefetch');
          return response.json();
        },
      });
    },
    [queryClient]
  );

  return useMemo(
    () => ({
      invalidateAll,
      invalidateList,
      invalidateQuestion,
      prefetchQuestion,
    }),
    [invalidateAll, invalidateList, invalidateQuestion, prefetchQuestion]
  );
}
