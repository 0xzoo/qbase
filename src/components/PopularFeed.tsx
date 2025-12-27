import React from 'react';
import QuestionList from './QuestionList';
import { mockPopularQuestions } from '../data/mockQuestions';

const PopularFeed: React.FC = () => {
  return <QuestionList questions={mockPopularQuestions} />;
};

export default PopularFeed;
