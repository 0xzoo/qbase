import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Flame, Clock, BarChart3, SortAsc } from 'lucide-react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import { TopicCard } from '../components/TopicCard';
import { apiClient } from '../lib/apiClient';
import './TopicsPage.css';
import type { TopicWithMetrics, TopicListResult } from '../lib/types';

type SortOption = 'momentum' | 'recent' | 'popular' | 'alphabetical';
type TimeWindow = '24h' | '7d' | '30d' | 'all';

const SORT_OPTIONS: { value: SortOption; label: string; icon: React.ReactNode }[] = [
  { value: 'momentum', label: 'Trending', icon: <Flame size={16} /> },
  { value: 'recent', label: 'New', icon: <Clock size={16} /> },
  { value: 'popular', label: 'Popular', icon: <BarChart3 size={16} /> },
  { value: 'alphabetical', label: 'A-Z', icon: <SortAsc size={16} /> },
];

const TIME_WINDOWS: { value: TimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

export const TopicsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // State
  const [topics, setTopics] = useState<TopicWithMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>(
    (searchParams.get('sort') as SortOption) || 'momentum'
  );
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(
    (searchParams.get('time') as TimeWindow) || '7d'
  );
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const limit = 30;

  // Fetch topics
  useEffect(() => {
    async function fetchTopics() {
      setLoading(true);
      setError(null);

      try {
        const response = await apiClient.get('/api/topics?limit=' + limit + '&offset=0&sortBy=' + sortBy + '&timeWindow=' + timeWindow);
        const data = await response.json() as TopicListResult;
        setTopics(data.topics);
        setTotal(data.total);
        setHasMore(data.topics.length < data.total);
      } catch (err) {
        console.error('Error fetching topics:', err);
        setError('Failed to load topics. Please try again.');
      } finally {
        setLoading(false);
      }
    }

    fetchTopics();
  }, [sortBy, timeWindow]);

  // Update URL params when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (sortBy !== 'momentum') params.set('sort', sortBy);
    if (timeWindow !== '7d') params.set('time', timeWindow);
    setSearchParams(params, { replace: true });
  }, [sortBy, timeWindow, setSearchParams]);

  // Search topics
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      // Reset to normal list
      setLoading(true);
      try {
        const response = await apiClient.get('/api/topics?limit=' + limit + '&offset=0&sortBy=' + sortBy + '&timeWindow=' + timeWindow);
        const data = await response.json() as TopicListResult;
        setTopics(data.topics);
        setTotal(data.total);
        setHasMore(data.topics.length < data.total);
      } catch (err) {
        console.error('Error fetching topics:', err);
      } finally {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    try {
      const response = await apiClient.get('/api/topics/search?q=' + searchQuery.trim() + '&limit=20');
      const data = await response.json() as { topics: TopicWithMetrics[] };
      setTopics(data.topics);
      setTotal(data.topics.length);
      setHasMore(false);
    } catch (err) {
      console.error('Error searching topics:', err);
    } finally {
      setLoading(false);
    }
  };

  // Load more topics
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;

    setLoadingMore(true);
    try {
      const response = await apiClient.get('/api/topics?limit=30&offset=' + topics.length + '&sortBy=' + sortBy + '&timeWindow=' + timeWindow);
      const data = await response.json() as TopicListResult;

      setTopics(prev => [...prev, ...data.topics]);
      setHasMore(topics.length + data.topics.length < data.total);
    } catch (err) {
      console.error('Error loading more topics:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Handle topic click
  const handleTopicClick = (topic: TopicWithMetrics) => {
    navigate(`/topics/${encodeURIComponent(topic.name.toLowerCase())}`);
  };

  return (
    <>
      <Header title="topics" />
      <Sidebar />
      <div className="topics-page">
        <div className="topics-page__header">
          <h1 className="topics-page__title">Explore Topics</h1>
        
        {/* Search */}
        <div className="topics-page__search">
          <Search size={18} className="topics-page__search-icon" />
          <input
            type="text"
            placeholder="Search topics..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="topics-page__search-input"
          />
        </div>

        {/* Filters */}
        <div className="topics-page__filters">
          {/* Sort buttons */}
          <div className="topics-page__sort-buttons">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`topics-page__sort-btn ${sortBy === option.value ? 'active' : ''}`}
                onClick={() => setSortBy(option.value)}
              >
                {option.icon}
                <span>{option.label}</span>
              </button>
            ))}
          </div>

          {/* Time window selector */}
          <div className="topics-page__time-selector">
            <span className="topics-page__time-label">⏱</span>
            {TIME_WINDOWS.map((window) => (
              <button
                key={window.value}
                className={`topics-page__time-btn ${timeWindow === window.value ? 'active' : ''}`}
                onClick={() => setTimeWindow(window.value)}
              >
                {window.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Topics grid */}
      <div className="topics-page__content">
        {loading ? (
          <div className="topics-page__loading">
            <div className="topics-page__loading-spinner" />
            <span>Loading topics...</span>
          </div>
        ) : error ? (
          <div className="topics-page__error">
            <p>{error}</p>
            <button onClick={() => window.location.reload()}>Try Again</button>
          </div>
        ) : topics.length === 0 ? (
          <div className="topics-page__empty">
            <p>No topics found</p>
            {searchQuery && (
              <button onClick={() => { setSearchQuery(''); handleSearch(); }}>
                Clear search
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="topic-cards-grid">
              {topics.map((topic) => (
                <TopicCard
                  key={topic.id}
                  topic={topic}
                  onClick={handleTopicClick}
                />
              ))}
            </div>

            {hasMore && (
              <div className="topics-page__load-more">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="topics-page__load-more-btn"
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
};

export default TopicsPage;
