import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';
import type { Query } from '../lib/types';

interface UseQuestionsOptions {
  limit?: number;
  offset?: number;
  sort?: 'new' | 'popular';
}

export function useQuestions(options: UseQuestionsOptions = {}) {
  const { limit = 20, offset = 0, sort = 'new' } = options;
  const [questions, setQuestions] = useState<Query[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await apiClient.get(`/api/queries?limit=${limit}&offset=${offset}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch questions: ${response.statusText}`);
      }

      const data = await response.json() as { results: Query[] };
      setQuestions(data.results);
    } catch (err) {
      console.error('Error fetching questions:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch questions');
    } finally {
      setLoading(false);
    }
  }, [limit, offset]);

  useEffect(() => {
    fetchQuestions();
  }, [fetchQuestions]);

  return { questions, loading, error, refetch: fetchQuestions };
}

export function useQuestion(id: string | undefined) {
  const [question, setQuestion] = useState<Query | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }

    const fetchQuestion = async () => {
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
    };

    fetchQuestion();
  }, [id]);

  return { question, loading, error };
}

