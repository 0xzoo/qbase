import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import type { Answer, AnswerWFname, ScaleConfig } from '../lib/types';
import { formatScaleAnswerValue } from '../lib/scale';
import { formatDateAnswerValue } from '../lib/date';
import { LikeButton } from './LikeButton';
import './AnswerCard.css';

interface AnswerCardProps {
  answer: Answer | AnswerWFname;
  questionText?: string;
  showActions?: boolean;
}

const AnswerCard: React.FC<AnswerCardProps> = ({ answer, questionText, showActions = true }) => {
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

  // Scale answers store raw numeric strings — format with scale_config when
  // the global feed endpoint included question metadata on the answer.
  const questionType = 'question_type' in answer ? (answer as { question_type?: string }).question_type : undefined;
  const questionScaleConfig = 'question_scale_config' in answer
    ? (answer as { question_scale_config?: ScaleConfig }).question_scale_config
    : undefined;
  const answerText = questionType === 'scale'
    ? formatScaleAnswerValue(answer.value, questionScaleConfig)
    : questionType === 'date'
      ? formatDateAnswerValue(answer.value)
      : answer.value;

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

      {showActions && (
        <div className="answer-footer">
          <LikeButton
            answerId={answer.id}
            initialLiked={answer.user_has_liked ?? false}
            initialCount={(answer.like_count ?? 0) || (answer.farcaster_likes ?? 0)}
            size={18}
          />
          <div className="action-button">
            <Share2 size={18} />
          </div>
        </div>
      )}
    </div>
  );
};

export default AnswerCard;
