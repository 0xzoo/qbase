import React from 'react';
import { useNavigate } from 'react-router-dom';
import { GitFork } from 'lucide-react';
import { DUPLICATE_THRESHOLD } from '../lib/consts';
import './CompactQuestionCard.css';

interface CompactQuestionCardProps {
  id: string;
  questionText: string;
  authorName?: string;
  authorFid?: number;
  avatarUrl?: string;
  matchScore?: number;
  onClick?: () => void;
  /** When provided, render a Fork button. Click stops propagation. */
  onFork?: () => void;
  showMatchBadge?: boolean;
  transparent?: boolean;
}

const CompactQuestionCard: React.FC<CompactQuestionCardProps> = ({
  id,
  questionText,
  authorName = 'anonymous',
  authorFid,
  avatarUrl,
  matchScore,
  onClick,
  onFork,
  showMatchBadge = true,
  transparent = false,
}) => {
  const navigate = useNavigate();
  
  const defaultAvatarUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${authorFid || 'default'}`;
  const finalAvatarUrl = avatarUrl || defaultAvatarUrl;
  
  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate(`/question/${id}`);
    }
  };

  const renderMatchBadge = () => {
    if (!showMatchBadge || matchScore === undefined) return null;
    
    const matchPercent = Math.round(matchScore * 100);
    const label = matchScore > DUPLICATE_THRESHOLD ? 'Exact Match' : `${matchPercent}% Match`;
    
    return (
      <span className="compact-card-match-badge">
        {label}
      </span>
    );
  };

  return (
    <div className={`compact-question-card ${transparent ? 'compact-question-card-transparent' : ''}`} onClick={handleClick}>
      <div className="compact-card-header">
        <div className="compact-card-author">
          <div className="compact-card-avatar">
            <img src={finalAvatarUrl} alt={`@${authorName}`} />
          </div>
          <span className="compact-card-author-name">{authorName}</span>
        </div>
        <div className="compact-card-actions">
          {renderMatchBadge()}
          {onFork && (
            <button
              type="button"
              className="compact-card-fork-btn"
              title="Fork: re-ask with a different answer shape"
              onClick={(e) => { e.stopPropagation(); onFork(); }}
            >
              <GitFork size={12} />
              <span>fork</span>
            </button>
          )}
        </div>
      </div>
      <div className="compact-card-question-text">{questionText}</div>
    </div>
  );
};

export default CompactQuestionCard;

