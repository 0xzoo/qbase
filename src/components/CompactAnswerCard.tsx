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
  isFarcasterReply?: boolean;
  createdAt?: number;
  questionText?: string;
  onClick?: () => void;
  className?: string;
}

// Farcaster logo SVG component
const FarcasterIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <span className="farcaster-icon" title="Reply from Farcaster">
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size} 
      height={size} 
      viewBox="0 0 22 20" 
      fill="none"
    >
      <g fill="currentColor" clipPath="url(#fc-icon)">
        <path d="M3.786.05h14.156v2.824h4.025l-.844 2.825h-.714v11.427c.358 0 .65.287.65.642v.77h.13c.358 0 .649.288.649.642v.77h-7.273v-.77c0-.354.29-.642.65-.642h.13v-.77c0-.309.22-.566.512-.628l-.014-6.306c-.23-2.519-2.37-4.493-4.98-4.493-2.608 0-4.75 1.974-4.979 4.494l-.013 6.3c.346.05.772.315.772.633v.77h.13c.358 0 .65.288.65.642v.77H.15v-.77c0-.354.29-.642.649-.642h.13v-.77c0-.355.29-.642.65-.642V5.7H.863L.02 2.874h3.766V.05Z"></path>
      </g>
      <defs>
        <clipPath id="fc-icon">
          <path fill="currentColor" d="M0 0h22v20H0z"></path>
        </clipPath>
      </defs>
    </svg>
  </span>
);

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
  isFarcasterReply = false,
  createdAt,
  questionText,
  onClick,
  className,
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
    ? `/4n0n.png`
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
      className={`compact-answer-card ${isOwnAnswer ? 'own-answer' : ''} ${isAnonymous ? 'anonymous' : ''} ${className || ''}`} 
      onClick={handleClick}
    >
      <div className="compact-answer-header">
        <div className="compact-answer-author">
          <div className="compact-answer-avatar">
            <img src={finalAvatarUrl} alt={displayName} />
          </div>
          <span className="compact-answer-author-name">
            {isAnonymous ? displayName : `@${displayName}`}
          </span>
          {isFarcasterReply && <FarcasterIcon size={12} />}
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
