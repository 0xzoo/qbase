import { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../lib/apiClient';
import type { Query } from '../lib/types';

interface UseQuestionsOptions {
  limit?: number;
  offset?: number;
  sort?: 'new' | 'popular';
  enableInfiniteScroll?: boolean;
}

export function useQuestions(options: UseQuestionsOptions = {}) {
  const { limit = 20, offset = 0, sort = 'new', enableInfiniteScroll = false } = options;
  const [questions, setQuestions] = useState<Query[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const currentOffsetRef = useRef(offset);

  const fetchQuestions = useCallback(async (append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    
    try {
      const fetchOffset = append ? currentOffsetRef.current : offset;
      const response = await apiClient.get(`/api/queries?limit=${limit}&offset=${fetchOffset}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch questions: ${response.statusText}`);
      }

      const data = await response.json() as { results: Query[]; limit: number; offset: number };
      
      if (append) {
        setQuestions(prev => [...prev, ...data.results]);
      } else {
        setQuestions(data.results);
        currentOffsetRef.current = offset;
      }
      
      // Update hasMore flag - if we got fewer results than requested, we're at the end
      setHasMore(data.results.length === limit);
      
      // Update offset for next fetch
      if (append) {
        currentOffsetRef.current += data.results.length;
      }
    } catch (err) {
      console.error('Error fetching questions:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch questions');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [limit, offset]);

  const loadMore = useCallback(() => {
    if (!loadingMore && !loading && hasMore && enableInfiniteScroll) {
      fetchQuestions(true);
    }
  }, [loadingMore, loading, hasMore, enableInfiniteScroll, fetchQuestions]);

  useEffect(() => {
    // Reset state when options change
    currentOffsetRef.current = offset;
    setHasMore(true);
    fetchQuestions(false);
  }, [fetchQuestions]);

  return { 
    questions, 
    loading, 
    loadingMore,
    error, 
    hasMore,
    loadMore,
    refetch: () => {
      currentOffsetRef.current = offset;
      setHasMore(true);
      fetchQuestions(false);
    }
  };
}

export function useQuestion(id: string | undefined) {
  const [question, setQuestion] = useState<Query | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQuestion = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const response = await apiClient.get(`/api/queries/${id}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          setError('Question not found');
        } else {
          throw new Error(`Failed to fetch question: ${response.statusText}`);
        }
      } else {
        const data = await response.json() as Query;
        setQuestion(data);
      }
    } catch (err) {
      console.error('Error fetching question:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch question');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchQuestion();
  }, [fetchQuestion]);

  return { question, loading, error, refetch: fetchQuestion };
}

