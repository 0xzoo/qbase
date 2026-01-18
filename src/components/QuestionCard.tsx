import React, { useState, useMemo } from 'react';
import { MessageCircle, MessageCircleDashed } from 'lucide-react';
import './QuestionCard.css';
import type { Query } from '../lib/types';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import { LikeButton } from './LikeButton';
import { RecastButton } from './RecastButton';
import { TopicTag } from './TopicTag';

interface QuestionCardProps {
  question: Query;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const navigate = useNavigate();
  const { hasSigner, activeSigner, isAuthenticated } = useAuth();
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [signerAction, setSignerAction] = useState<string>('');

  const handleCardClick = () => {
    // Pass useCarousel: true so the question page shows carousel navigation
    navigate(`/question/${question.id}`, { state: { useCarousel: true } });
  };

  const authorName = question.coiner_fname || 'anonymous';
  // Use avatar URL from backend (fetched from Neynar), fallback to dicebear
  const avatarUrl = question.coiner_avatar_url || 
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${question.coiner_fid || question.coiner_id || 'default'}`;
  
  // Answer counts
  const publicAnswers = question.pub_answers || 0;
  const privateAnswers = question.priv_answers || 0;

  // Extract topics from tags (format: "source:topic")
  const topics = useMemo(() => {
    if (!question.tags || question.tags.length === 0) return [];
    return question.tags
      .map((tag) => {
        const parts = tag.split(':');
        return parts.length >= 2 ? parts.slice(1).join(':').trim() : null;
      })
      .filter((topic): topic is string => topic !== null && topic.length > 0)
      .slice(0, 3); // Show max 3 topics
  }, [question.tags]);

  const handleLikeError = (error: string) => {
    console.error('Like error:', error);
    // Could show a toast notification here if you want
  };

  const handleRecastError = (error: string) => {
    console.error('Recast error:', error);
    // Could show a toast notification here if you want
  };

  return (
    <>
      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action={signerAction}
      />
      
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
          </div>
          <h3 className="question-text">{question.stem}</h3>
          
          {/* Hide topics for now
          topics.length > 0 && false && (
            <div className="question-topics">
              {topics.map((topic) => (
                <TopicTag key={topic} name={topic} size="small" />
              ))}
            </div>
          )*/}
          
          <div className="card-footer">
            <div className="action-item" title="Public answers">
              <MessageCircle size={16} strokeWidth={2} />
              <span>{publicAnswers}</span>
            </div>
            <div className="action-item" title="Private answers">
              <MessageCircleDashed size={16} strokeWidth={2} />
              <span>{privateAnswers}</span>
            </div>
            <LikeButton
              castHash={question.casthash}
              initialLiked={question.user_has_liked || false}
              initialCount={question.farcaster_likes || 0}
              showCount={true}
              size={16}
              className="action-item"
              onError={handleLikeError}
            />
            <RecastButton
              castHash={question.casthash}
              initialRecasted={question.user_has_recasted || false}
              initialCount={question.farcaster_recasts || 0}
              showCount={true}
              size={16}
              className="action-item"
              onError={handleRecastError}
            />
          </div>
        </div>
      </div>
    </>
  );
};

export default QuestionCard;
