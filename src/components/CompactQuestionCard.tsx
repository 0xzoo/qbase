import React from 'react';
import { useNavigate } from 'react-router-dom';
import './CompactQuestionCard.css';

interface CompactQuestionCardProps {
  id: string;
  questionText: string;
  authorName?: string;
  authorFid?: number;
  avatarUrl?: string;
  matchScore?: number;
  onClick?: () => void;
  showMatchBadge?: boolean;
}

const CompactQuestionCard: React.FC<CompactQuestionCardProps> = ({
  id,
  questionText,
  authorName = 'anonymous',
  authorFid,
  avatarUrl,
  matchScore,
  onClick,
  showMatchBadge = true,
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
    const label = matchScore > 0.95 ? 'Exact Match' : `${matchPercent}% Match`;
    
    return (
      <span className="compact-card-match-badge">
        {label}
      </span>
    );
  };

  return (
    <div className="compact-question-card" onClick={handleClick}>
      <div className="compact-card-header">
        <div className="compact-card-author">
          <div className="compact-card-avatar">
            <img src={finalAvatarUrl} alt={`@${authorName}`} />
          </div>
          <span className="compact-card-author-name">{authorName}</span>
        </div>
        {renderMatchBadge()}
      </div>
      <div className="compact-card-question-text">{questionText}</div>
    </div>
  );
};

export default CompactQuestionCard;

