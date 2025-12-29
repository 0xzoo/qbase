import React from 'react';
import QuestionList from './QuestionList';
import { useQuestions } from '../hooks/useQuestions';

const NewFeed: React.FC = () => {
  const { questions, loading, error } = useQuestions({ sort: 'new' });

  if (loading) {
    return <div className="loading-spinner">Loading...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  return <QuestionList questions={questions} />;
};

export default NewFeed;
