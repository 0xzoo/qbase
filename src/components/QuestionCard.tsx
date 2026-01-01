import React, { useState, useEffect } from 'react';
import { MessageCircle, MessageCircleDashed, Repeat, Heart } from 'lucide-react';
import './QuestionCard.css';
import type { Query } from '../lib/types';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import { apiClient } from '../lib/apiClient';

interface QuestionCardProps {
  question: Query;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const navigate = useNavigate();
  const { hasSigner, activeSigner, isAuthenticated } = useAuth();
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [signerAction, setSignerAction] = useState<string>('');

  const handleCardClick = () => {
    navigate(`/question/${question.id}`);
  };

  const authorName = question.coiner_fname || 'anonymous';
  // Use avatar URL from backend (fetched from Neynar), fallback to dicebear
  const avatarUrl = question.coiner_avatar_url || 
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${question.coiner_fid || question.coiner_id || 'default'}`;
  
  // Answer counts
  const publicAnswers = question.pub_answers || 0;
  const privateAnswers = question.priv_answers || 0;
  
  // Farcaster engagement data with local state
  // Initialize from backend data about whether user has already liked/recasted
  const [liked, setLiked] = useState(question.user_has_liked || false);
  const [recasted, setRecasted] = useState(question.user_has_recasted || false);
  const [likeCount, setLikeCount] = useState(question.farcaster_likes || 0);
  const [recastCount, setRecastCount] = useState(question.farcaster_recasts || 0);

  // Update state when question prop changes (e.g., on page reload or question change)
  useEffect(() => {
    setLiked(question.user_has_liked || false);
    setRecasted(question.user_has_recasted || false);
    setLikeCount(question.farcaster_likes || 0);
    setRecastCount(question.farcaster_recasts || 0);
  }, [question.id, question.user_has_liked, question.user_has_recasted, question.farcaster_likes, question.farcaster_recasts]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    
    if (!isAuthenticated) {
      alert('Please sign in to like');
      return;
    }

    if (!hasSigner) {
      setSignerAction('like this question');
      setShowSignerModal(true);
      return;
    }

    if (!question.casthash) {
      alert('This question has not been posted to Farcaster yet');
      return;
    }

    try {
      const response = await apiClient.post('/api/farcaster/like', {
        signerUuid: activeSigner?.signer_uuid,
        castHash: question.casthash,
        action: liked ? 'unlike' : 'like',
      });

      if (response.ok) {
        setLiked(!liked);
        setLikeCount(prev => liked ? prev - 1 : prev + 1);
      }
    } catch (error) {
      console.error('Error liking:', error);
    }
  };

  const handleRecast = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    
    if (!isAuthenticated) {
      alert('Please sign in to recast');
      return;
    }

    if (!hasSigner) {
      setSignerAction('recast this question');
      setShowSignerModal(true);
      return;
    }

    if (!question.casthash) {
      alert('This question has not been posted to Farcaster yet');
      return;
    }

    try {
      const response = await apiClient.post('/api/farcaster/recast', {
        signerUuid: activeSigner?.signer_uuid,
        castHash: question.casthash,
        action: recasted ? 'unrecast' : 'recast',
      });

      if (response.ok) {
        setRecasted(!recasted);
        setRecastCount(prev => recasted ? prev - 1 : prev + 1);
      }
    } catch (error) {
      console.error('Error recasting:', error);
    }
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
          <div className="card-footer">
            <div className="action-item" title="Public answers">
              <MessageCircle size={16} strokeWidth={2} />
              <span>{publicAnswers}</span>
            </div>
            <div className="action-item" title="Private answers">
              <MessageCircleDashed size={16} strokeWidth={2} />
              <span>{privateAnswers}</span>
            </div>
            <button 
              className={`action-item action-button ${liked ? 'active' : ''}`}
              onClick={handleLike}
              title={liked ? 'Unlike' : 'Like'}
            >
              <Heart size={16} strokeWidth={2} fill={liked ? 'currentColor' : 'none'} />
              <span>{likeCount}</span>
            </button>
            <button 
              className={`action-item action-button ${recasted ? 'recast-active' : ''}`}
              onClick={handleRecast}
              title={recasted ? 'Remove recast' : 'Recast'}
            >
              <Repeat size={16} strokeWidth={2} />
              <span>{recastCount}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default QuestionCard;
