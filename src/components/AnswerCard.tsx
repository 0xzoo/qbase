import React from 'react';
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

  const authorName = ('user_fname' in answer && answer.user_fname) 
    ? answer.user_fname 
    : (answer.user_id === '[anonymous]' || answer.user_id === '[anonymous]')
      ? 'Anonymous' 
      : 'anonymous';
  const avatarSeed = ('user_fid' in answer && answer.user_fid) 
    ? answer.user_fid.toString() 
    : (typeof answer.user_id === 'number' ? answer.user_id.toString() : 'default');
  const answerText = typeof answer.value === 'string' 
    ? answer.value 
    : JSON.stringify(answer.value);

  return (
    <div className="answer-card" onClick={handleCardClick}>
      <div className="answer-header">
        <div className="answer-author">
          <img
            src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${avatarSeed}`}
            alt={authorName}
            className="author-avatar"
          />
          <span className="author-name">@{authorName}</span>
        </div>
        <span className="answer-context">answered</span>
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
