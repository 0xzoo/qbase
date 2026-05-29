import React, { Suspense } from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import './FeedPage.css';

const QuizzesFeed = React.lazy(() => import('../components/QuizzesFeed'));

const QuizzesPage: React.FC = () => {
  return (
    <>
      <Header title="quizzes" />
      <Sidebar />
      <div className="mobile-layout-container">
        <div className="feed-content">
          <Suspense fallback={<div className="loading-spinner">Loading…</div>}>
            <QuizzesFeed />
          </Suspense>
        </div>
      </div>
    </>
  );
};

export default QuizzesPage;
