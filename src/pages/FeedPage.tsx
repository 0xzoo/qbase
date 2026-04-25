import React, { Suspense, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { ChevronDown, Plus } from 'lucide-react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import Tabs from '../components/Tabs';
import FAB from '../components/FAB';
import SignerBanner from '../components/SignerBanner';
import NewFeed from '../components/NewFeed';
import CreateQueryModal from '../components/CreateQueryModal';
import CreatePollModal from '../components/poll/CreatePollModal';
import { useQuestionCacheUtils } from '../hooks/useQuestions';
import './FeedPage.css';

const PopularFeed = React.lazy(() => import('../components/PopularFeed'));
const AnswersFeed = React.lazy(() => import('../components/AnswersFeed'));
const QuizzesFeed = React.lazy(() => import('../components/QuizzesFeed'));

const FeedPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { invalidateAll } = useQuestionCacheUtils();

  let activeTab = 'questions';
  if (location.pathname.includes('/answers')) activeTab = 'answers';
  if (location.pathname.includes('/quizzes')) activeTab = 'quizzes';

  const [sort, setSort] = useState<'new' | 'popular' | 'following'>('new');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPollModalOpen, setIsPollModalOpen] = useState(false);

  // Invalidate questions cache when returning to feed after creating a question
  // This ensures newly created questions appear at the top
  // Uses sessionStorage flag to work regardless of navigation method (back button, tabs, etc.)
  useEffect(() => {
    const locationState = location.state as { fromQuestionCreation?: boolean } | null;
    const recentCreation = sessionStorage.getItem('qbase_question_created');
    
    // Check both: location state (from back button) OR sessionStorage flag (any navigation)
    const shouldRefresh = locationState?.fromQuestionCreation || 
      (recentCreation && Date.now() - parseInt(recentCreation) < 60000); // Within 1 minute
    
    if (shouldRefresh) {
      console.log('[FeedPage] Recent question creation detected, invalidating cache');
      invalidateAll();
      // Clear both flags so it doesn't refetch on every render
      sessionStorage.removeItem('qbase_question_created');
      if (locationState?.fromQuestionCreation) {
        window.history.replaceState({}, document.title);
      }
    }
  }, [location.state, invalidateAll]);

  // Reset sort when switching tabs (optional, but often good UX)
  // React.useEffect(() => {
  //   setSort('new');
  // }, [activeTab]);

  const handlers = useSwipeable({
    onSwipedLeft: () => {
      if (activeTab === 'questions') navigate('/answers');
      if (activeTab === 'answers') navigate('/quizzes');
    },
    onSwipedRight: () => {
      if (activeTab === 'quizzes') navigate('/answers');
      if (activeTab === 'answers') navigate('/questions');
    },
    trackMouse: true
  });

  const renderContent = () => {
    if (activeTab === 'questions') {
      return sort === 'new' ? <NewFeed /> : <Suspense fallback={<div className="loading-spinner">Loading...</div>}><PopularFeed /></Suspense>;
    } else if (activeTab === 'answers') {
      return (
        <Suspense fallback={<div className="loading-spinner">Loading...</div>}>
          <AnswersFeed />
        </Suspense>
      );
    } else {
      return (
        <Suspense fallback={<div className="loading-spinner">Loading...</div>}>
          <QuizzesFeed />
        </Suspense>
      );
    }
  };

  return (
    <>
      <Header />
      <Sidebar />
      <div className="mobile-layout-container">
        <SignerBanner />
        <Tabs activeTab={activeTab} />

        <div className="feed-controls">
          <div className="sort-toggle">
            <div className="sort-dropdown">
              <button
                className="dropdown-trigger"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              >
                {sort === 'new' ? 'new' : sort === 'popular' ? 'popular' : 'following'}
                <ChevronDown
                  size={16}
                  className={`dropdown-chevron ${isDropdownOpen ? 'open' : ''}`}
                />
              </button>

              {isDropdownOpen && (
                <div className="dropdown-menu">
                  <button
                    className={`dropdown-item ${sort === 'new' ? 'active' : ''}`}
                    onClick={() => {
                      setSort('new');
                      setIsDropdownOpen(false);
                    }}
                  >
                    new
                  </button>
                  <button
                    className={`dropdown-item ${sort === 'popular' ? 'active' : ''}`}
                    onClick={() => {
                      setSort('popular');
                      setIsDropdownOpen(false);
                    }}
                  >
                    popular
                  </button>
                  <button
                    className={`dropdown-item ${sort === 'following' ? 'active' : ''}`}
                    onClick={() => {
                      setSort('following');
                      setIsDropdownOpen(false);
                    }}
                  >
                    following
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="feed-content" {...handlers}>
          {renderContent()}
        </div>

        <FAB
          onClick={() => {
            // if (activeTab === 'quizzes' || location.pathname.includes('/quizzes')) {
            //   navigate('/create-quiz');
            // } else {
              setIsModalOpen(true);
            // }
          }}
          onPollClick={() => setIsPollModalOpen(true)}
          // icon={(activeTab === 'quizzes' || location.pathname.includes('/quizzes')) ? <Plus size={32} strokeWidth={2.5} color="#2b95d6" /> : undefined}
        />
        <CreateQueryModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
        <CreatePollModal isOpen={isPollModalOpen} onClose={() => setIsPollModalOpen(false)} />
      </div>
    </>
  );
};

export default FeedPage;
