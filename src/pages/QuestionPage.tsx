import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { MessageCircle, MessageCircleDashed, Repeat, Share, Pencil, Eye, ChevronRight, ChevronDown, Heart } from 'lucide-react';
import Header from '../components/Header';
import QuestionRenderer from '../components/QuestionRenderer';
import { useUserSettings } from '../hooks/useUserSettings';
import { useQuestion } from '../hooks/useQuestions';
import { useAnswers } from '../hooks/useAnswers';
import { useQuestions } from '../hooks/useQuestions';
import type { Audiences, Answer, AnswerWFname } from '../lib/types';
import './QuestionPage.css';

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, updateDefaultAudience } = useUserSettings();
  
  // Initialize visibility from settings, with fallback to 'Private'
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showResponses, setShowResponses] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  const { question, loading: questionLoading } = useQuestion(id);
  const { answers, loading: answersLoading } = useAnswers({ queryId: id });
  const { questions: allQuestions } = useQuestions({ limit: 100 });

  const questionIndex = question ? allQuestions.findIndex(q => q.id === question.id) : -1;
  const responses = answers as (Answer | AnswerWFname)[];

  // Update visibility when settings load
  useEffect(() => {
    if (settings?.defaultAudience) {
      setVisibility(settings.defaultAudience);
    }
  }, [settings]);

  useEffect(() => {
    // Reset state when question ID changes
    setIsDropdownOpen(false);
    // Keep the user's preferred visibility setting
    setAnswerValue(null);
    setShowResponses(false);
    setIsAnimating(false);

    if (location.state && location.state.direction) {
      setAnimationClass(location.state.direction === 'next' ? 'slide-in-right' : 'slide-in-left');
    } else {
      setAnimationClass('');
    }
  }, [id, location.state]);

  useEffect(() => {
    setIsAnimating(true);
    const timer = setTimeout(() => setIsAnimating(false), 300);
    return () => clearTimeout(timer);
  }, [showResponses]);

  const handleSwipe = (direction: string) => {
    if (direction === 'Left') {
      // Next question
      if (questionIndex >= 0 && questionIndex < allQuestions.length - 1) {
        navigate(`/question/${allQuestions[questionIndex + 1].id}`, {
          state: { direction: 'next' },
          replace: true
        });
        setShowResponses(false); // Reset view
      }
    } else if (direction === 'Right') {
      // Previous question
      if (questionIndex > 0) {
        navigate(`/question/${allQuestions[questionIndex - 1].id}`, {
          state: { direction: 'prev' },
          replace: true
        });
        setShowResponses(false); // Reset view
      }
    }
  };

  const handlers = useSwipeable({
    onSwipedLeft: () => handleSwipe('Left'),
    onSwipedRight: () => handleSwipe('Right'),
    trackMouse: true
  });

  const isAnswerValid = () => {
    if (answerValue === null || answerValue === undefined) return false;
    if (typeof answerValue === 'string') return answerValue.trim().length > 0;
    if (Array.isArray(answerValue)) return answerValue.every(v => v && v.toString().trim().length > 0);
    return true; // Numbers, booleans are valid if present
  };

  // Handle visibility change and persist to settings
  const handleVisibilityChange = async (newVisibility: Audiences) => {
    setVisibility(newVisibility);
    setIsDropdownOpen(false);
    
    // Persist to user settings
    try {
      await updateDefaultAudience(newVisibility);
    } catch (error) {
      console.error('Failed to save visibility preference:', error);
      // Still update local state even if save fails
    }
  };

  if (questionLoading) return <div className="loading-spinner">Loading...</div>;
  if (!question) return <div>Question not found</div>;

  const isExternalEntry = location.key === 'default';

  return (
    <div className="question-page-wrapper" {...handlers} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--qbase-bg)' }}>
      <Header
        showBack
        backLabel={isExternalEntry ? 'Feed' : 'Back'}
        onBack={isExternalEntry ? () => navigate('/questions') : undefined}
      />

      <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%' }}>
        <div className={`question-content ${animationClass}`} key={id}>
          <div className="question-text-container">
            <h1 className="qp-question-text">{question.stem}</h1>
          </div>

          <div className="qp-metadata">
            <span className="coined-by">
              coined by <Link to={`/user/${question.coiner_fname || 'anonymous'}`}>@{question.coiner_fname || 'anonymous'}</Link>
            </span>
            <div className="qp-actions">
              <div className="qp-action-left">
                <Pencil size={18} className="icon-btn" onClick={() => setShowResponses(false)} />
                <div
                  className={`icon-with-count ${showResponses ? 'active' : ''}`}
                  onClick={() => setShowResponses(true)}
                  style={{ cursor: 'pointer' }}
                >
                  <MessageCircle size={18} />
                  <span>{(question.comments || 0) + responses.length}</span>
                </div>
                <div className="icon-with-count">
                  <MessageCircleDashed size={18} />
                  <span>0</span>
                </div>
                <div className="icon-with-count">
                  <Heart size={18} />
                  <span>0</span>
                </div>
                <div className="icon-with-count">
                  <Repeat size={18} />
                  <span>0</span>
                </div>
              </div>
              <Share size={18} className="icon-btn" />
            </div>
          </div>

          <div className="qp-slider-container">
            <div
              className="qp-slider-track"
              style={{ transform: `translateX(-${showResponses ? 50 : 0}%)` }}
            >
              <div className={`qp-slide ${showResponses && !isAnimating ? 'collapsed-slide' : ''}`}>
                <QuestionRenderer
                  question={question}
                  value={answerValue}
                  onChange={setAnswerValue}
                />
                <div className="visibility-control">
                  <div
                    className="visibility-trigger"
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  >
                    <Eye size={16} />
                    <span>{visibility}</span>
                    <ChevronDown size={14} />
                  </div>

                  {isDropdownOpen && (
                    <div className="visibility-dropdown">
                      <div onClick={() => handleVisibilityChange('Public')}>Public</div>
                      <div onClick={() => handleVisibilityChange('Anon')}>Anon</div>
                      <div onClick={() => handleVisibilityChange('Private')}>Private</div>
                    </div>
                  )}
                </div>
              </div>
              <div className={`qp-slide ${!showResponses && !isAnimating ? 'collapsed-slide' : ''}`}>
                <div className="response-list">
                  {answersLoading ? (
                    <div className="loading-spinner">Loading answers...</div>
                  ) : responses.length > 0 ? (
                    responses.map(response => {
                      const answerText = typeof response.value === 'string' 
                        ? response.value 
                        : JSON.stringify(response.value);
                      const authorName = ('user_fname' in response && response.user_fname) 
                        ? response.user_fname 
                        : (response.user_id === '[anonymous]' || response.user_id === '[anonymous]')
                          ? 'Anonymous' 
                          : 'anonymous';
                      
                      return (
                        <div
                          key={response.id}
                          className="response-item clickable"
                          onClick={() => navigate(`/answer/${response.id}`, {
                            state: {
                              questionText: question.stem,
                              answerText: answerText,
                              authorName: authorName,
                              date: new Date(response.created_at).toLocaleDateString()
                            }
                          })}
                        >
                          <p className="response-text">{answerText}</p>
                          <span className="response-user">- {authorName}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="no-responses">No responses yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="qp-footer">
          {questionIndex > 0 && (
            <button
              className="prev-btn"
              onClick={() => handleSwipe('Right')}
            >
              <ChevronRight size={24} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
          <button
            className={`edit-btn ${isAnswerValid() ? 'active' : ''}`}
            disabled={!isAnswerValid()}
          >
            Save
          </button>
          <button
            className="next-btn"
            onClick={() => handleSwipe('Left')}
            disabled={questionIndex === -1 || questionIndex === allQuestions.length - 1}
          >
            <ChevronRight size={24} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuestionPage;
