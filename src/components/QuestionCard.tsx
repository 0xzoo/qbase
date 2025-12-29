import React, { useState } from 'react';
import { MessageCircle, MessageCircleDashed, Repeat, Heart } from 'lucide-react';
import './QuestionCard.css';
import type { Query } from '../lib/types';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';

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
  const avatarSeed = question.coiner_fid?.toString() || question.coiner_id?.toString() || 'default';
  const totalAnswers = (question.pub_answers || 0) + (question.priv_answers || 0);
  const comments = question.comments || totalAnswers;
  
  // Farcaster engagement data with local state
  const [liked, setLiked] = useState(false);
  const [recasted, setRecasted] = useState(false);
  const [likeCount, setLikeCount] = useState(question.farcaster_likes || 0);
  const [recastCount, setRecastCount] = useState(question.farcaster_recasts || 0);
  const farcasterReplies = question.farcaster_replies || 0;

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
      const response = await fetch('/api/farcaster/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerUuid: activeSigner?.signer_uuid,
          castHash: question.casthash,
          action: liked ? 'unlike' : 'like',
        }),
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
      const response = await fetch('/api/farcaster/recast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerUuid: activeSigner?.signer_uuid,
          castHash: question.casthash,
          action: recasted ? 'unrecast' : 'recast',
        }),
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
                to={`/user/${authorName}`}
                className="author-link"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="author-avatar">
                  <img
                    src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${avatarSeed}`}
                    alt={`${authorName}'s avatar`}
                  />
                </div>
                <span className="author-name">{authorName}</span>
              </Link>
            </div>
          </div>
          <h3 className="question-text">{question.stem}</h3>
          <div className="card-footer">
            <div className="action-item">
              <MessageCircle size={16} strokeWidth={2} />
              <span>{comments}</span>
            </div>
            <div className="action-item">
              <MessageCircleDashed size={16} strokeWidth={2} />
              <span>{farcasterReplies}</span>
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
              className={`action-item action-button ${recasted ? 'active' : ''}`}
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
