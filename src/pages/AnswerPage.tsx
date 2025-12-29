import React from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Header from '../components/Header';
import { useAnswer } from '../hooks/useAnswers';
import { useQuestion } from '../hooks/useQuestions';
import './AnswerPage.css';
import PermissionControl from '../components/PermissionControl';

const AnswerPage: React.FC = () => {
  const { answerId } = useParams<{ answerId: string }>();
  const location = useLocation();

  const { answer, loading: answerLoading } = useAnswer(answerId);
  const { question, loading: questionLoading } = useQuestion(answer?.q_id);

  // Try to get data from location state first (passed from other pages)
  const stateData = location.state || {};
  let { questionText: stateQuestionText, answerText: stateAnswerText, authorName: stateAuthorName, date: stateDate } = stateData;

  // Use API data if available, otherwise fall back to state
  const questionText = question?.stem || stateQuestionText;
  const answerText = answer 
    ? (typeof answer.value === 'string' ? answer.value : JSON.stringify(answer.value))
    : stateAnswerText;
  const authorName = answer 
    ? (('user_fname' in answer && answer.user_fname)
        ? answer.user_fname 
        : '4n0n')
    : stateAuthorName;
  const date = answer 
    ? new Date(answer.created_at).toLocaleDateString()
    : stateDate;

  if (answerLoading || questionLoading) {
    return (
      <>
        <Header showBack />
        <div className="loading-spinner">Loading...</div>
      </>
    );
  }

  if (!answerText) {
    return (
      <>
        <Header showBack />
        <div className="answer-not-found">Answer not found</div>
      </>
    );
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
