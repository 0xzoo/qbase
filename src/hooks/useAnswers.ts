import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';
import type { Answer } from '../lib/types';

interface UseAnswersOptions {
  queryId?: string;
  limit?: number;
  offset?: number;
  audience?: string;
}

export function useAnswers(options: UseAnswersOptions = {}) {
  const { queryId, limit = 20, offset = 0, audience = 'Public,Anon' } = options;
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnswers = useCallback(async () => {
    if (!queryId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const response = await apiClient.get(
        `/api/queries/${queryId}/answers?limit=${limit}&offset=${offset}&audience=${audience}`
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch answers: ${response.statusText}`);
      }

      const data = await response.json() as { results: Answer[] };
      setAnswers(data.results);
    } catch (err) {
      console.error('Error fetching answers:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch answers');
    } finally {
      setLoading(false);
    }
  }, [queryId, limit, offset, audience]);

  useEffect(() => {
    fetchAnswers();
  }, [fetchAnswers]);

  return { answers, loading, error, refetch: fetchAnswers };
}

export function useAnswer(id: string | undefined) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }

    const fetchAnswer = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const response = await apiClient.get(`/api/answers/${id}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError('Answer not found');
          } else {
            throw new Error(`Failed to fetch answer: ${response.statusText}`);
          }
        } else {
          const data = await response.json() as Answer;
          setAnswer(data);
        }
      } catch (err) {
        console.error('Error fetching answer:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch answer');
      } finally {
        setLoading(false);
      }
    };

    fetchAnswer();
  }, [id]);

  return { answer, loading, error };
}

