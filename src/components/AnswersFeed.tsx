import React, { useState, useEffect } from 'react';
import AnswerList from './AnswerList';
import type { Answer, AnswerWFname } from '../lib/types';
import { apiClient } from '../lib/apiClient';

// Extended type for answers with question_stem from API
type AnswerWithQuestion = (Answer | AnswerWFname) & { question_stem?: string };

const AnswersFeed: React.FC = () => {
  const [allAnswers, setAllAnswers] = useState<AnswerWithQuestion[]>([]);
  const [questionTexts, setQuestionTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAnswers = async () => {
      setLoading(true);
      setError(null);

      try {
        // Use the new centralized /api/answers endpoint
        const response = await apiClient.get('/api/answers?limit=100&audience=Public,Anon');
        
        if (!response.ok) {
          throw new Error(`Failed to fetch answers: ${response.statusText}`);
        }

        const data = await response.json() as { 
          results: AnswerWithQuestion[]
        };

        // Extract question texts from the response (they're included in each answer)
        const texts: Record<string, string> = {};
        data.results.forEach((answer) => {
          if (answer.q_id && answer.question_stem) {
            texts[answer.q_id] = answer.question_stem;
          }
        });

        setAllAnswers(data.results);
        setQuestionTexts(texts);
      } catch (err) {
        console.error('Error fetching answers:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch answers');
      } finally {
        setLoading(false);
      }
    };

    fetchAnswers();
  }, []);

  if (loading) {
    return <div className="loading-spinner">Loading...</div>;
  }

  if (error) {
    return <div className="error-message">Unable to load answers. Please try again.</div>;
  }

  if (allAnswers.length === 0) {
    return <div className="error-message">No answers available yet.</div>;
  }

  return <AnswerList answers={allAnswers} questionTexts={questionTexts} />;
};

export default AnswersFeed;

