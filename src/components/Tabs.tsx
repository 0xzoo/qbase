import React from 'react';
import { Link } from 'react-router-dom';
import './Tabs.css';

interface TabsProps {
  activeTab: string;
}

const Tabs: React.FC<TabsProps> = ({ activeTab }) => {
  return (
    <div className="tabs-container">
      <Link
        to="/questions"
        className={`tab-button ${activeTab === 'questions' ? 'active' : ''}`}
      >
        questions
      </Link>
      <Link
        to="/answers"
        className={`tab-button ${activeTab === 'answers' ? 'active' : ''}`}
      >
        answers
      </Link>
      <Link
        to="/quizzes"
        className={`tab-button ${activeTab === 'quizzes' ? 'active' : ''}`}
      >
        quizzes
      </Link>
    </div>
  );
};

export default Tabs;
