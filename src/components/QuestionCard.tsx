import React from 'react';
import { MessageCircle, MessageCircleDashed, Repeat, Heart } from 'lucide-react';
import './QuestionCard.css';
import type { Question } from '../data/mockQuestions';

interface QuestionCardProps {
  question: Question;
}

import { Link, useNavigate } from 'react-router-dom';

const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const navigate = useNavigate();

  const handleCardClick = () => {
    navigate(`/question/${question.id}`);
  };

  return (
    <div className="question-card-wrapper" onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className="question-card">
        <div className="card-header">
          <div className="author-info">
            <Link
              to={`/user/${question.author.name}`}
              className="author-link"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="author-avatar">
                <img
                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${question.author.avatarSeed}`}
                  alt={`${question.author.name}'s avatar`}
                />
              </div>
              <span className="author-name">{question.author.name}</span>
            </Link>
          </div>
        </div>
        <h3 className="question-text">{question.text}</h3>
        <div className="card-footer">
          <div className="action-item">
            <MessageCircle size={16} strokeWidth={2} />
            <span>{question.comments}</span>
          </div>
          <div className="action-item">
            <MessageCircleDashed size={16} strokeWidth={2} />
            <span>{question.comments}</span>
          </div>
          <div className="action-item">
            <Heart size={16} strokeWidth={2} />
            <span>{question.likes}</span>
          </div>
          <div className="action-item">
            <Repeat size={16} strokeWidth={2} />
            <span>{question.shares}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuestionCard;
