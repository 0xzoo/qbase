import React, { useState, useEffect } from 'react';
import AnswerList from './AnswerList';
import { useQuestions } from '../hooks/useQuestions';
import { useAnswers } from '../hooks/useAnswers';
import type { Answer, AnswerWFname, Query } from '../lib/types';
import { apiClient } from '../lib/apiClient';

const AnswersFeed: React.FC = () => {
  const [allAnswers, setAllAnswers] = useState<(Answer | AnswerWFname)[]>([]);
  const [questionTexts, setQuestionTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { questions } = useQuestions({ limit: 10 });

  useEffect(() => {
    const fetchAnswersForQuestions = async () => {
      if (questions.length === 0) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Fetch answers for each question
        const answerPromises = questions.map(async (q: Query) => {
          try {
            const response = await apiClient.get(
              `/api/queries/${q.id}/answers?limit=5&audience=Public,Anon`
            );
            if (response.ok) {
              const data = await response.json() as { results: (Answer | AnswerWFname)[] };
              return { questionId: q.id, questionText: q.stem, answers: data.results };
            }
            return { questionId: q.id, questionText: q.stem, answers: [] };
          } catch (err) {
            console.error(`Error fetching answers for question ${q.id}:`, err);
            return { questionId: q.id, questionText: q.stem, answers: [] };
          }
        });

        const results = await Promise.all(answerPromises);
        
        // Combine all answers and sort by created_at
        const combined: (Answer | AnswerWFname)[] = [];
        const texts: Record<string, string> = {};

        results.forEach(({ questionId, questionText, answers }) => {
          texts[questionId] = questionText;
          combined.push(...answers);
        });

        // Sort by created_at descending
        combined.sort((a, b) => {
          const aTime = typeof a.created_at === 'number' 
            ? a.created_at 
            : new Date(a.created_at as string).getTime();
          const bTime = typeof b.created_at === 'number' 
            ? b.created_at 
            : new Date(b.created_at as string).getTime();
          return bTime - aTime;
        });

        setAllAnswers(combined);
        setQuestionTexts(texts);
      } catch (err) {
        console.error('Error fetching answers:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch answers');
      } finally {
        setLoading(false);
      }
    };

    fetchAnswersForQuestions();
  }, [questions]);

  if (loading) {
    return <div className="loading-spinner">Loading...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  if (allAnswers.length === 0) {
    return <div className="no-data">No answers yet. Be the first to answer a question!</div>;
  }

  return <AnswerList answers={allAnswers} questionTexts={questionTexts} />;
};

export default AnswersFeed;

