import React, { useState, useEffect } from 'react';
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

// Helper function to format relative time
const getRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  if (weeks > 0) return `${weeks}w`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
};

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
  const [pfpUrl, setPfpUrl] = useState<string | null>(avatarUrl || null);
  
  // Fetch pfp from API if we have a FID and no avatarUrl provided
  useEffect(() => {
    if (avatarUrl || !authorFid || isAnonymous) return;
    
    const fetchPfp = async () => {
      try {
        const response = await fetch(`/api/user/${authorFid}/avatar`);
        if (response.ok) {
          const data = await response.json();
          if (data.avatarUrl) {
            setPfpUrl(data.avatarUrl);
          }
        }
      } catch (error) {
        console.error('Failed to fetch pfp:', error);
      }
    };
    
    fetchPfp();
  }, [authorFid, avatarUrl, isAnonymous]);
  
  const defaultAvatarUrl = isAnonymous 
    ? `https://api.dicebear.com/7.x/shapes/svg?seed=anon`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${authorFid || 'default'}`;
  const finalAvatarUrl = pfpUrl || defaultAvatarUrl;
  
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

  const relativeTime = createdAt ? getRelativeTime(createdAt) : null;

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
        {relativeTime && (
          <span className="compact-answer-time" title={createdAt ? new Date(createdAt).toLocaleString() : undefined}>
            {relativeTime}
          </span>
        )}
      </div>
      <div className="compact-answer-text">{answerText}</div>
    </div>
  );
};

export default CompactAnswerCard;
