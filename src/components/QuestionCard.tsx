import React, { useMemo } from 'react';
import { MessageCircle, MessageCircleDashed } from 'lucide-react';
import './QuestionCard.css';
import type { Query } from '../lib/types';
import { Link, useNavigate } from 'react-router-dom';
import { LikeButton } from './LikeButton';
import { ShareButton } from './ShareButton';
import { isSnapRenderable } from '../lib/snapEligibility';

interface QuestionCardProps {
  question: Query;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const navigate = useNavigate();

  const handleCardClick = () => {
    navigate(`/question/${question.id}`);
  };

  const authorName = question.coiner_fname || 'anonymous';
  const avatarUrl = question.coiner_avatar_url || 
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${question.coiner_fid || question.coiner_id || 'default'}`;
  
  const publicAnswers = question.pub_answers || 0;
  const privateAnswers = question.priv_answers || 0;

  const _topics = useMemo(() => {
    if (!question.tags || question.tags.length === 0) return [];
    return question.tags
      .map((tag) => {
        const parts = tag.split(':');
        return parts.length >= 2 ? parts.slice(1).join(':').trim() : null;
      })
      .filter((topic): topic is string => topic !== null && topic.length > 0)
      .slice(0, 3);
  }, [question.tags]);

  const questionUrl = `${window.location.origin}/${isSnapRenderable(question) ? 'snap/' : ''}question/${question.id}`;

  return (
    <div className="question-card-wrapper" onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className="question-card">
        <div className="card-header">
          <div className="author-info">
            <Link
              to={`/ask/${authorName}`}
              className="author-link"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="author-avatar">
                <img
                  src={avatarUrl}
                  alt={`@${authorName}`}
                />
              </div>
              <span className="author-name">{authorName}</span>
            </Link>
          </div>
          {question.open_poll_at && <span className="question-card-poll-badge" title="This question has a poll open">poll open</span>}
        </div>
        <h3 className="question-text">{question.stem}</h3>
        
        <div className="card-footer">
          <div className="action-item" title="Public answers">
            <MessageCircle size={16} strokeWidth={2} />
            <span>{publicAnswers}</span>
          </div>
          <div className="action-item" title="Private answers">
            <MessageCircleDashed size={16} strokeWidth={2} />
            <span>{privateAnswers}</span>
          </div>
          {/* Question likes are Farcaster reactions on its cast: a count here, liking on the question page */}
          {question.casthash && (
            <LikeButton
              initialLiked={false}
              initialCount={question.farcaster_likes || 0}
              showCount={true}
              size={16}
              className="action-item"
              readOnly
            />
          )}
          <ShareButton
            url={questionUrl}
            text={question.stem}
            size={16}
            className="action-item"
          />
        </div>
      </div>
    </div>
  );
};

export default QuestionCard;
