import React from 'react';
import QuestionCard from './QuestionCard';
import type { Query } from '../lib/types';
import './QuestionList.css';

interface QuestionListProps {
  questions: Query[];
}

const QuestionList: React.FC<QuestionListProps> = ({ questions }) => {
  return (
    <div className="question-list">
      {questions.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
    </div>
  );
};

export default QuestionList;
