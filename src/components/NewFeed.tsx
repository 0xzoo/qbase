import React from 'react';
import QuestionList from './QuestionList';
import { mockQuestions } from '../data/mockQuestions';

const NewFeed: React.FC = () => {
  return <QuestionList questions={mockQuestions} />;
};

export default NewFeed;
