import React from 'react';
import AnswerCard from './AnswerCard';
import type { Answer, AnswerWFname } from '../lib/types';
import './AnswerList.css';

interface AnswerListProps {
  answers: (Answer | AnswerWFname)[];
  questionTexts?: Record<string, string>;
}

const AnswerList: React.FC<AnswerListProps> = ({ answers, questionTexts }) => {
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
