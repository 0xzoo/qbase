import React from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Header from '../components/Header';
import { mockQuestions } from '../data/mockQuestions';
import { mockResponses } from '../data/mockResponses';
import './AnswerPage.css';
import PermissionControl from '../components/PermissionControl';

const AnswerPage: React.FC = () => {
  const { answerId } = useParams<{ answerId: string }>();
  const location = useLocation();

  // Try to get data from location state first (passed from ProfilePage)
  const { questionText, answerText, authorName, date } = location.state || {};

  // If not in state, try to find in mockResponses (passed from QuestionPage or direct link)
  if (!answerText && answerId) {
    const response = mockResponses.find(r => r.id === Number(answerId));
    if (response) {
      answerText = response.text;
      authorName = response.username;
      const question = mockQuestions.find(q => q.id === response.questionId);
      if (question) {
        questionText = question.text;
      }
    }
  }

  if (!answerText) {
    return <div className="answer-not-found">Answer not found</div>;
  }

  return (
    <>
      <Header showBack />
      <div className="answer-page mobile-layout-container">
        <div className="answer-page-answer-content">
          <div className="question-section">
            <h1 className="ap-question-text">{questionText}</h1>
          </div>

          <div className="answer-section">
            <div className="answer-card">
              <div className="answer-header">
                <div className="answer-author">
                  <div className="author-avatar">
                    <img
                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${authorName}`}
                      alt={`${authorName}'s avatar`}
                    />
                  </div>
                  <span className="author-name">{authorName}</span>
                </div>
                <div className="answer-meta-controls">
                  <PermissionControl
                    initialAudience="Public"
                    onSave={(audience, allowlistId) => {
                      console.log('Saved permissions:', { audience, allowlistId });
                    }}
                  />
                  {date && <span className="answer-date">{date}</span>}
                </div>
              </div>
              <p className="ap-answer-text">{answerText}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default AnswerPage;
