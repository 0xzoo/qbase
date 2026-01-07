import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { queryKeys } from '../lib/queryClient';
import type { Answer, AnswerSubmission } from '../lib/types';

interface AnswersResponse {
  results: Answer[];
}

interface UseAnswersOptions {
  queryId?: string;
  limit?: number;
  offset?: number;
  audience?: string;
}

// API functions
async function fetchAnswers(
  queryId: string,
  params: { limit: number; offset: number; audience: string }
): Promise<AnswersResponse> {
  const response = await apiClient.get(
    `/api/queries/${queryId}/answers?limit=${params.limit}&offset=${params.offset}&audience=${params.audience}`
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch answers: ${response.statusText}`);
  }

  return response.json();
}

async function fetchSingleAnswer(id: string): Promise<Answer> {
  const response = await apiClient.get(`/api/answers/${id}`);
  
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Answer not found');
    }
    throw new Error(`Failed to fetch answer: ${response.statusText}`);
  }

  return response.json();
}

async function fetchUserAnswerForQuestion(
  userId: number,
  queryId: string
): Promise<{
  primary_type: string;
  answer?: Answer | null;
  answers?: Answer[];
  count?: number;
}> {
  const response = await apiClient.get(`/api/users/${userId}/answers?q_id=${queryId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch user answer: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Hook for fetching answers for a question with React Query
 * 
 * Features:
 * - Stale-while-revalidate for instant UI with background refresh
 * - Automatic retry with exponential backoff
 * - Lazy loading (only fetches when queryId is provided)
 */
export function useAnswers(options: UseAnswersOptions = {}) {
  const { queryId, limit = 20, offset = 0, audience = 'Public,Anon' } = options;

  const query = useQuery({
    queryKey: queryKeys.answers.forQuery(queryId ?? '', { limit, offset, audience }),
    queryFn: () => fetchAnswers(queryId!, { limit, offset, audience }),
    enabled: !!queryId,
    staleTime: 30 * 1000, // 30 seconds
  });

  return {
    answers: query.data?.results ?? [],
    loading: query.isLoading,
    error: query.error?.message ?? null,
    refetch: query.refetch,
    isFetching: query.isFetching,
  };
}

/**
 * Hook for fetching a single answer by ID
 */
export function useAnswer(id: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.answers.detail(id ?? ''),
    queryFn: () => fetchSingleAnswer(id!),
    enabled: !!id,
    staleTime: 60 * 1000, // 1 minute
  });

  return {
    answer: query.data ?? null,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    refetch: query.refetch,
  };
}

/**
 * Hook to fetch user's existing answer(s) for a specific question
 * Returns identity answer (single) or temporal answers (array)
 * 
 * This fetches from the server API which includes:
 * - Public answers (D1)
 * - Server-encrypted answers (Nillion standard collections)
 * 
 * For E2E encrypted answers (Private/Allowlist with encryption_version: 'v2'),
 * use useUserAnswerForQuestionWithE2E which also checks the client-side Nillion storage.
 */
export function useUserAnswerForQuestion(userId: number | undefined, queryId: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.answers.userForQuestion(userId ?? 0, queryId ?? ''),
    queryFn: () => fetchUserAnswerForQuestion(userId!, queryId!),
    enabled: !!userId && !!queryId,
    staleTime: 30 * 1000, // 30 seconds
  });

  return {
    data: query.data ?? null,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    refetch: query.refetch,
  };
}

/**
 * Hook for submitting/updating answers with optimistic updates
 */
export function useAnswerMutation() {
  const queryClient = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: async (submission: AnswerSubmission & { authToken: string }) => {
      const { authToken, ...data } = submission;
      const response = await fetch('/api/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || 'Failed to submit answer');
      }

      return response.json() as Promise<Answer>;
    },
    onSuccess: (newAnswer, variables) => {
      // Invalidate answers for this question
      queryClient.invalidateQueries({ 
        queryKey: queryKeys.answers.forQuery(variables.q_id) 
      });
      
      // Invalidate user's answer for this question
      queryClient.invalidateQueries({ 
        queryKey: queryKeys.answers.userForQuestion(variables.user_id, variables.q_id) 
      });
      
      // Invalidate the question itself (answer counts changed)
      queryClient.invalidateQueries({ 
        queryKey: queryKeys.questions.detail(variables.q_id) 
      });
      
      // Invalidate question lists (counts changed)
      queryClient.invalidateQueries({ 
        queryKey: ['questions', 'list'] 
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (params: { 
      answerId: string; 
      updates: Partial<Answer>; 
      authToken: string 
    }) => {
      const { answerId, updates, authToken } = params;
      const response = await fetch(`/api/answers/${answerId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || 'Failed to update answer');
      }

      return response.json() as Promise<Answer>;
    },
    onMutate: async ({ answerId, updates }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.answers.detail(answerId) });
      
      // Snapshot previous value
      const previousAnswer = queryClient.getQueryData<Answer>(
        queryKeys.answers.detail(answerId)
      );
      
      // Optimistically update
      if (previousAnswer) {
        queryClient.setQueryData<Answer>(
          queryKeys.answers.detail(answerId),
          { ...previousAnswer, ...updates, edited: true }
        );
      }
      
      return { previousAnswer };
    },
    onError: (_err, { answerId }, context) => {
      // Rollback on error
      if (context?.previousAnswer) {
        queryClient.setQueryData(
          queryKeys.answers.detail(answerId),
          context.previousAnswer
        );
      }
    },
    onSettled: (_data, _error, { answerId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.answers.detail(answerId) });
    },
  });

  return {
    submit: submitMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    isSubmitting: submitMutation.isPending,
    isUpdating: updateMutation.isPending,
    submitError: submitMutation.error?.message ?? null,
    updateError: updateMutation.error?.message ?? null,
  };
}

/**
 * Utility hook for invalidating answer-related caches
 */
export function useAnswerCacheUtils() {
  const queryClient = useQueryClient();

  return {
    invalidateForQuery: (queryId: string) => 
      queryClient.invalidateQueries({ queryKey: queryKeys.answers.forQuery(queryId) }),
    invalidateAnswer: (id: string) => 
      queryClient.invalidateQueries({ queryKey: queryKeys.answers.detail(id) }),
    invalidateUserAnswers: (userId: number) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.answers.userAll(userId) }),
    prefetchAnswersForQuery: async (queryId: string, options = {}) => {
      const { limit = 20, offset = 0, audience = 'Public,Anon' } = options as UseAnswersOptions;
      await queryClient.prefetchQuery({
        queryKey: queryKeys.answers.forQuery(queryId, { limit, offset, audience }),
        queryFn: () => fetchAnswers(queryId, { limit, offset, audience }),
      });
    },
  };
}

// Re-export E2E answer reading hook for convenience
export { usePrivateAnswerRead } from './usePrivateAnswerRead';
