import React from 'react';
import { useNavigate } from 'react-router-dom';
import './CompactAnswerCard.css';

interface CompactAnswerCardProps {
  id: string;
  answerText: string;
  authorName: string;
  authorFid?: number;
  avatarUrl?: string;
  isOwnAnswer?: boolean;
  isAnonymous?: boolean;
  createdAt?: number;
  questionText?: string;
  onClick?: () => void;
}

const CompactAnswerCard: React.FC<CompactAnswerCardProps> = ({
  id,
  answerText,
  authorName,
  authorFid,
  avatarUrl,
  isOwnAnswer = false,
  isAnonymous = false,
  createdAt,
  questionText,
  onClick,
}) => {
  const navigate = useNavigate();
  
  const defaultAvatarUrl = isAnonymous 
    ? `https://api.dicebear.com/7.x/shapes/svg?seed=anon`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${authorFid || 'default'}`;
  const finalAvatarUrl = avatarUrl || defaultAvatarUrl;
  
  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate(`/answer/${id}`, {
        state: {
          questionText,
          answerText,
          authorName,
          date: createdAt ? new Date(createdAt).toLocaleDateString() : undefined
        }
      });
    }
  };

  const displayName = isAnonymous 
    ? (isOwnAnswer ? 'Your anonymous answer' : '4n0n')
    : authorName;

  return (
    <div 
      className={`compact-answer-card ${isOwnAnswer ? 'own-answer' : ''} ${isAnonymous ? 'anonymous' : ''}`} 
      onClick={handleClick}
    >
      <div className="compact-answer-header">
        <div className="compact-answer-author">
          <div className="compact-answer-avatar">
            <img src={finalAvatarUrl} alt={displayName} />
          </div>
          <span className="compact-answer-author-name">
            {isOwnAnswer && !isAnonymous && <span className="you-badge">You</span>}
            {isAnonymous ? displayName : `@${displayName}`}
          </span>
        </div>
        {createdAt && (
          <span className="compact-answer-date">
            {new Date(createdAt).toLocaleDateString()}
          </span>
        )}
      </div>
      <div className="compact-answer-text">{answerText}</div>
    </div>
  );
};

export default CompactAnswerCard;

