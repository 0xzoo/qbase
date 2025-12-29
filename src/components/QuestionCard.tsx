import React from 'react';
import { MessageCircle, MessageCircleDashed, Repeat, Heart } from 'lucide-react';
import './QuestionCard.css';
import type { Query } from '../lib/types';
import { Link, useNavigate } from 'react-router-dom';

interface QuestionCardProps {
  question: Query;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const navigate = useNavigate();

  const handleCardClick = () => {
    navigate(`/question/${question.id}`);
  };

  const authorName = question.coiner_fname || 'anonymous';
  const avatarSeed = question.coiner_fid?.toString() || question.coiner_id?.toString() || 'default';
  const totalAnswers = (question.pub_answers || 0) + (question.priv_answers || 0);
  const comments = question.comments || totalAnswers;

  return (
    <div className="question-card-wrapper" onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className="question-card">
        <div className="card-header">
          <div className="author-info">
            <Link
              to={`/user/${authorName}`}
              className="author-link"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="author-avatar">
                <img
                  src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${avatarSeed}`}
                  alt={`${authorName}'s avatar`}
                />
              </div>
              <span className="author-name">{authorName}</span>
            </Link>
          </div>
        </div>
        <h3 className="question-text">{question.stem}</h3>
        <div className="card-footer">
          <div className="action-item">
            <MessageCircle size={16} strokeWidth={2} />
            <span>{comments}</span>
          </div>
          <div className="action-item">
            <MessageCircleDashed size={16} strokeWidth={2} />
            <span>{comments}</span>
          </div>
          <div className="action-item">
            <Heart size={16} strokeWidth={2} />
            <span>0</span>
          </div>
          <div className="action-item">
            <Repeat size={16} strokeWidth={2} />
            <span>0</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuestionCard;
