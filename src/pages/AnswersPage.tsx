import React, { Suspense, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import './FeedPage.css';

const AnswersFeed = React.lazy(() => import('../components/AnswersFeed'));

const AnswersPage: React.FC = () => {
  const [sort, setSort] = useState<'new' | 'popular' | 'following'>('new');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  return (
    <>
      <Header title="answers" />
      <Sidebar />
      <div className="mobile-layout-container">
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

        <div className="feed-content">
          <Suspense fallback={<div className="loading-spinner">Loading...</div>}>
            <AnswersFeed />
          </Suspense>
        </div>
      </div>
    </>
  );
};

export default AnswersPage;
