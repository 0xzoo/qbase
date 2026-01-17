import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, Heart } from 'lucide-react';
import type { Answer, AnswerWFname } from '../lib/types';
import './AnswerCard.css';

interface AnswerCardProps {
  answer: Answer | AnswerWFname;
  questionText?: string;
}

const AnswerCard: React.FC<AnswerCardProps> = ({ answer, questionText }) => {
  const navigate = useNavigate();

  const handleCardClick = (e: React.MouseEvent) => {
    // Prevent navigation if clicking on action buttons
    if ((e.target as HTMLElement).closest('.action-button')) {
      return;
    }
    navigate(`/answer/${answer.id}`);
  };

  const authorName: string = ('user_fname' in answer && answer.user_fname)
    ? (answer.user_fname as string)
    : '4n0n'

  // Extract user_fid safely
  const authorFid = 'user_fid' in answer ? (answer.user_fid as number) : undefined;
  const isAnonymous = authorName === '4n0n' || authorName === 'Anonymous' || !authorFid;

  // State for real PFP
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);

  // Fetch PFP if we have a FID and it's not anonymous
  useEffect(() => {
    if (!authorFid || isAnonymous) return;

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
  }, [authorFid, isAnonymous]);

  // Use fetched PFP or fallback to DiceBear
  const finalAvatarUrl = pfpUrl || `/4n0n.png`;

  // Value is now always plain display text
  const answerText = answer.value;

  return (
    <div className="answer-card" onClick={handleCardClick}>
      <div className="answer-header">
        <div className="answer-author">
          <img
            src={finalAvatarUrl}
            alt={authorName}
            className="author-avatar"
          />
          <span className="author-name">{authorName}</span>
        </div>
      </div>

      {questionText && (
        <div className="answer-question-context">
          {questionText}
        </div>
      )}

      <div className="answer-content">
        {answerText}
      </div>

      <div className="answer-footer">
        <div className="action-button">
          <Heart size={18} />
          <span>0</span>
        </div>
        <div className="action-button">
          <Share2 size={18} />
        </div>
      </div>
    </div>
  );
};

export default AnswerCard;
