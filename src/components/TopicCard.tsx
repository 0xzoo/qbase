import React from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus, Flame, BarChart3, Activity, Zap } from 'lucide-react';
import './TopicCard.css';
import type { TopicWithMetrics } from '../lib/types';

export interface TopicCardProps {
  topic: TopicWithMetrics;
  /** Size variant */
  size?: 'small' | 'medium' | 'large';
  /** Show chart preview */
  showChart?: boolean;
  /** Optional click handler */
  onClick?: (topic: TopicWithMetrics) => void;
}

/**
 * Get status info based on momentum score and trend
 */
function getTopicStatus(topic: TopicWithMetrics): {
  emoji: string;
  icon: React.ReactNode;
  label: string;
  colorClass: string;
} {
  const { momentum_score, trend_direction } = topic;

  if (momentum_score >= 70) {
    return {
      emoji: '🔥',
      icon: <Flame size={16} className="topic-status-icon topic-status-icon--hot" />,
      label: 'Hot',
      colorClass: 'topic-card--hot',
    };
  }

  if (trend_direction === 'rising' || (momentum_score >= 30 && topic.growth_rate_7d > 10)) {
    return {
      emoji: '📈',
      icon: <TrendingUp size={16} className="topic-status-icon topic-status-icon--rising" />,
      label: 'Rising',
      colorClass: 'topic-card--rising',
    };
  }

  if (trend_direction === 'falling' || topic.growth_rate_7d < -10) {
    return {
      emoji: '💤',
      icon: <TrendingDown size={16} className="topic-status-icon topic-status-icon--quiet" />,
      label: 'Quiet',
      colorClass: 'topic-card--quiet',
    };
  }

  return {
    emoji: '📊',
    icon: <BarChart3 size={16} className="topic-status-icon topic-status-icon--steady" />,
    label: 'Steady',
    colorClass: 'topic-card--steady',
  };
}

/**
 * Format growth rate for display
 */
function formatGrowthRate(rate: number): string {
  if (rate > 0) return `+${rate.toFixed(1)}%`;
  if (rate < 0) return `${rate.toFixed(1)}%`;
  return '0%';
}

/**
 * TopicCard - Card component for displaying topic with metrics
 */
export const TopicCard: React.FC<TopicCardProps> = ({
  topic,
  size = 'medium',
  showChart = false,
  onClick,
}) => {
  const status = getTopicStatus(topic);
  const topicUrl = `/topics/${encodeURIComponent(topic.name.toLowerCase())}`;

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.preventDefault();
      onClick(topic);
    }
  };

  const questionsToday = topic.questions_24h || 0;
  const totalQuestions = topic.total_questions || 0;
  const growthRate = topic.growth_rate_7d || 0;

  // Get trend icon for growth rate
  const getTrendIcon = () => {
    if (growthRate > 5) {
      return <TrendingUp size={12} className="growth-icon growth-icon--up" />;
    }
    if (growthRate < -5) {
      return <TrendingDown size={12} className="growth-icon growth-icon--down" />;
    }
    return <Minus size={12} className="growth-icon growth-icon--flat" />;
  };

  return (
    <Link
      to={topicUrl}
      className={`topic-card topic-card--${size} ${status.colorClass}`}
      onClick={handleClick}
    >
      <div className="topic-card__header">
        <span className="topic-card__status-emoji">{status.emoji}</span>
        <h3 className="topic-card__name">{topic.name}</h3>
      </div>

      <div className="topic-card__stats">
        <div className="topic-card__stat topic-card__stat--total">
          <span className="topic-card__stat-value">{totalQuestions}</span>
          <span className="topic-card__stat-label">Qs</span>
        </div>

        {questionsToday > 0 && (
          <div className="topic-card__stat topic-card__stat--today">
            <span className="topic-card__stat-value">+{questionsToday}</span>
            <span className="topic-card__stat-label">today</span>
          </div>
        )}
      </div>

      <div className="topic-card__growth">
        {getTrendIcon()}
        <span className={`topic-card__growth-value ${growthRate > 0 ? 'positive' : growthRate < 0 ? 'negative' : ''}`}>
          {formatGrowthRate(growthRate)}
        </span>
        <span className="topic-card__growth-period">(7d)</span>
      </div>

      {showChart && (
        <div className="topic-card__chart-preview">
          <Activity size={24} className="topic-card__chart-icon" />
        </div>
      )}
    </Link>
  );
};

export default TopicCard;
