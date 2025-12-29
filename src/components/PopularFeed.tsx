import React from 'react';
import QuestionList from './QuestionList';
import { useQuestions } from '../hooks/useQuestions';

const PopularFeed: React.FC = () => {
  // For now, we'll use the same endpoint but could add sorting by popularity later
  const { questions, loading, error } = useQuestions({ sort: 'popular' });

  if (loading) {
    return <div className="loading-spinner">Loading...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  return <QuestionList questions={questions} />;
};

export default PopularFeed;
