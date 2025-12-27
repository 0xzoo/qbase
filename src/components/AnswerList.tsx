import React from 'react';
import AnswerCard from './AnswerCard';
import type { MockAnswer } from '../data/mockQuestions';
import './AnswerList.css';

interface AnswerListProps {
  answers: MockAnswer[];
}

const AnswerList: React.FC<AnswerListProps> = ({ answers }) => {
  return (
    <div className="answer-list">
      {answers.map((a) => (
        <AnswerCard key={a.id} answer={a} />
      ))}
    </div>
  );
};

export default AnswerList;
