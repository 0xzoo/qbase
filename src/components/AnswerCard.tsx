import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, Heart } from 'lucide-react';
import type { MockAnswer } from '../data/mockQuestions';
import './AnswerCard.css';

interface AnswerCardProps {
  answer: MockAnswer;
}

const AnswerCard: React.FC<AnswerCardProps> = ({ answer }) => {
  const navigate = useNavigate();

  const handleCardClick = (e: React.MouseEvent) => {
    // Prevent navigation if clicking on action buttons
    if ((e.target as HTMLElement).closest('.action-button')) {
      return;
    }
    navigate(`/answer/${answer.id}`);
  };

  return (
    <div className="answer-card" onClick={handleCardClick}>
      <div className="answer-header">
        <div className="answer-author">
          <img
            src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${answer.author.avatarSeed}`}
            alt={answer.author.name}
            className="author-avatar"
          />
          <span className="author-name">@{answer.author.name}</span>
        </div>
        <span className="answer-context">answered</span>
      </div>

      <div className="answer-question-context">
        {answer.questionText}
      </div>

      <div className="answer-content">
        {answer.text}
      </div>

      <div className="answer-footer">
        <div className="action-button">
          <Heart size={18} />
          <span>{answer.likes}</span>
        </div>
        <div className="action-button">
          <Share2 size={18} />
        </div>
      </div>
    </div>
  );
};

export default AnswerCard;
