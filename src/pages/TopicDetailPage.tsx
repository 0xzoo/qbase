import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, MessageSquare, Hash, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { TopicTag } from '../components/TopicTag';
import { CompactQuestionCard } from '../components/CompactQuestionCard';
import { apiClient } from '../lib/apiClient';
import './TopicDetailPage.css';
import type { TopicWithMetrics, Query, Topic } from '../lib/types';

/**
 * Get status info based on momentum and trend
 */
function getTopicStatus(topic: TopicWithMetrics): {
  emoji: string;
  label: string;
  colorClass: string;
} {
  const { momentum_score, trend_direction } = topic;

  if (momentum_score >= 70) {
    return { emoji: '🔥', label: 'Hot', colorClass: 'hot' };
  }
  if (trend_direction === 'rising' || (momentum_score >= 30 && topic.growth_rate_7d > 10)) {
    return { emoji: '📈', label: 'Rising', colorClass: 'rising' };
  }
  if (trend_direction === 'falling' || topic.growth_rate_7d < -10) {
    return { emoji: '💤', label: 'Quiet', colorClass: 'quiet' };
  }
  return { emoji: '📊', label: 'Steady', colorClass: 'steady' };
}

export const TopicDetailPage: React.FC = () => {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  // State
  const [topic, setTopic] = useState<TopicWithMetrics | null>(null);
  const [questions, setQuestions] = useState<Query[]>([]);
  const [relatedTopics, setRelatedTopics] = useState<TopicWithMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(true);

  // Fetch topic details
  useEffect(() => {
    async function fetchTopic() {
      if (!name) return;

      setLoading(true);
      setError(null);

      try {
        const data = await apiClient<{ topic: TopicWithMetrics }>(`/api/topics/${encodeURIComponent(name)}`, {
          method: 'GET',
        });
        setTopic(data.topic);

        // Fetch related topics
        if (data.topic?.id) {
          const relatedData = await apiClient<{ topics: TopicWithMetrics[] }>(
            `/api/topics/${data.topic.id}/related`,
            { method: 'GET' }
          );
          setRelatedTopics(relatedData.topics || []);
        }
      } catch (err) {
        console.error('Error fetching topic:', err);
        setError('Topic not found');
      } finally {
        setLoading(false);
      }
    }

    fetchTopic();
  }, [name]);

  // Fetch questions for this topic
  useEffect(() => {
    async function fetchQuestions() {
      if (!topic?.name) return;

      setQuestionsLoading(true);

      try {
        // For now, fetch all questions and filter by topic tag
        // In the future, we could add a /api/topics/:id/questions endpoint
        const data = await apiClient<{ results: Query[] }>('/api/queries', {
          method: 'GET',
          params: {
            limit: '50',
          },
        });

        // Filter questions that have this topic in their tags
        const topicName = topic.name.toLowerCase();
        const filtered = data.results.filter((q) => {
          if (!q.tags) return false;
          return q.tags.some((tag) => {
            const parts = tag.split(':');
            const tagTopic = parts.length >= 2 ? parts.slice(1).join(':').toLowerCase() : '';
            return tagTopic === topicName;
          });
        });

        setQuestions(filtered);
      } catch (err) {
        console.error('Error fetching questions:', err);
      } finally {
        setQuestionsLoading(false);
      }
    }

    fetchQuestions();
  }, [topic?.name]);

  if (loading) {
    return (
      <div className="topic-detail-page">
        <div className="topic-detail-page__loading">
          <div className="topic-detail-page__loading-spinner" />
          <span>Loading topic...</span>
        </div>
      </div>
    );
  }

  if (error || !topic) {
    return (
      <div className="topic-detail-page">
        <div className="topic-detail-page__error">
          <h2>Topic Not Found</h2>
          <p>The topic "{name}" doesn't exist or has no questions yet.</p>
          <Link to="/topics" className="topic-detail-page__back-link">
            <ArrowLeft size={16} />
            Browse all topics
          </Link>
        </div>
      </div>
    );
  }

  const status = getTopicStatus(topic);
  const growthRate = topic.growth_rate_7d || 0;

  const getTrendIcon = () => {
    if (growthRate > 5) return <TrendingUp size={14} className="trend-icon trend-icon--up" />;
    if (growthRate < -5) return <TrendingDown size={14} className="trend-icon trend-icon--down" />;
    return <Minus size={14} className="trend-icon trend-icon--flat" />;
  };

  return (
    <div className="topic-detail-page">
      {/* Header */}
      <div className="topic-detail-page__header">
        <Link to="/topics" className="topic-detail-page__back-link">
          <ArrowLeft size={18} />
          <span>Topics</span>
        </Link>

        <div className="topic-detail-page__title-row">
          <span className="topic-detail-page__status-emoji">{status.emoji}</span>
          <h1 className="topic-detail-page__title">#{topic.name}</h1>
        </div>

        {/* Stats */}
        <div className="topic-detail-page__stats">
          <div className="topic-detail-page__stat">
            <MessageSquare size={18} />
            <span className="topic-detail-page__stat-value">{topic.total_questions || 0}</span>
            <span className="topic-detail-page__stat-label">Questions</span>
          </div>
          <div className="topic-detail-page__stat">
            <Hash size={18} />
            <span className="topic-detail-page__stat-value">{topic.total_answers || 0}</span>
            <span className="topic-detail-page__stat-label">Answers</span>
          </div>
          <div className="topic-detail-page__stat">
            <Users size={18} />
            <span className="topic-detail-page__stat-value">{topic.total_contributors || 0}</span>
            <span className="topic-detail-page__stat-label">Contributors</span>
          </div>
        </div>

        {/* Growth indicator */}
        <div className="topic-detail-page__growth">
          {getTrendIcon()}
          <span className={`topic-detail-page__growth-value ${growthRate > 0 ? 'positive' : growthRate < 0 ? 'negative' : ''}`}>
            {growthRate > 0 ? '+' : ''}{growthRate.toFixed(1)}%
          </span>
          <span className="topic-detail-page__growth-period">in the last 7 days</span>
        </div>

        {/* Related topics */}
        {relatedTopics.length > 0 && (
          <div className="topic-detail-page__related">
            <h3 className="topic-detail-page__related-title">Related Topics:</h3>
            <div className="topic-detail-page__related-tags">
              {relatedTopics.map((t) => (
                <TopicTag
                  key={t.id}
                  name={t.name}
                  topicId={t.id}
                  size="medium"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Questions */}
      <div className="topic-detail-page__content">
        <h2 className="topic-detail-page__section-title">
          Questions about {topic.name}
        </h2>

        {questionsLoading ? (
          <div className="topic-detail-page__questions-loading">
            Loading questions...
          </div>
        ) : questions.length === 0 ? (
          <div className="topic-detail-page__questions-empty">
            <p>No questions about this topic yet.</p>
            <Link to="/questions" className="topic-detail-page__ask-btn">
              Ask a question
            </Link>
          </div>
        ) : (
          <div className="topic-detail-page__questions">
            {questions.map((question) => (
              <CompactQuestionCard key={question.id} question={question} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TopicDetailPage;
