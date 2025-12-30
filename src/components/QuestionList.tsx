import React from 'react';
import QuestionCard from './QuestionCard';
import type { Query } from '../lib/types';
import './QuestionList.css';

interface QuestionListProps {
  questions: Query[];
  isLoading?: boolean;
}

const QuestionList: React.FC<QuestionListProps> = ({ questions, isLoading = false }) => {
  if (isLoading) {
    return (
      <div className="question-list">
        <div className="empty-list">
          <div className="spinner"></div>
          <p>Loading questions...</p>
        </div>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="question-list">
        <div className="empty-list">
          <p className="empty-message">No questions yet</p>
          <p className="empty-submessage">Be the first to ask a question!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="question-list">
      {questions.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
    </div>
  );
};

export default QuestionList;
