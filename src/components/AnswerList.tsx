import React from 'react';
import AnswerCard from './AnswerCard';
import type { Answer, AnswerWFname } from '../lib/types';
import './AnswerList.css';

interface AnswerListProps {
  answers: (Answer | AnswerWFname)[];
  questionTexts?: Record<string, string>;
  isLoading?: boolean;
}

const AnswerList: React.FC<AnswerListProps> = ({ answers, questionTexts, isLoading = false }) => {
  if (isLoading) {
    return (
      <div className="answer-list">
        <div className="empty-state">
          <div className="spinner"></div>
          <p>Loading answers...</p>
        </div>
      </div>
    );
  }

  if (answers.length === 0) {
    return (
      <div className="answer-list">
        <div className="empty-state">
          <p className="empty-message">No answers yet</p>
          <p className="empty-submessage">Be the first to answer!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="answer-list">
      {answers.map((a) => (
        <AnswerCard 
          key={a.id} 
          answer={a} 
          questionText={questionTexts?.[a.q_id]}
        />
      ))}
    </div>
  );
};

export default AnswerList;
