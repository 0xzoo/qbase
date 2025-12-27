import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { MessageCircle, MessageCircleDashed, Repeat, Share, Pencil, Eye, ChevronRight, ChevronDown, Heart } from 'lucide-react';
import { mockQuestions } from '../data/mockQuestions';
import { mockResponses } from '../data/mockResponses';
import Header from '../components/Header';
import QuestionRenderer from '../components/QuestionRenderer';
import './QuestionPage.css';

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [visibility, setVisibility] = useState('Public');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showResponses, setShowResponses] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  const questionIndex = mockQuestions.findIndex(q => q.id === Number(id));
  const question = mockQuestions[questionIndex];
  const responses = mockResponses.filter(r => r.questionId === Number(id));

  useEffect(() => {
    // Reset state when question ID changes
    setIsDropdownOpen(false);
    setVisibility('Public');
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
      if (questionIndex < mockQuestions.length - 1) {
        navigate(`/question/${mockQuestions[questionIndex + 1].id}`, {
          state: { direction: 'next' },
          replace: true
        });
        setShowResponses(false); // Reset view
      }
    } else if (direction === 'Right') {
      // Previous question
      if (questionIndex > 0) {
        navigate(`/question/${mockQuestions[questionIndex - 1].id}`, {
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
            <h1 className="qp-question-text">{question.text}</h1>
          </div>

          <div className="qp-metadata">
            <span className="coined-by">
              coined by <Link to={`/user/${question.author.name}`}>@{question.author.name}</Link>
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
                  <span>{question.comments + responses.length}</span>
                </div>
                <div className="icon-with-count">
                  <MessageCircleDashed size={18} />
                  <span>0</span>
                </div>
                <div className="icon-with-count">
                  <Heart size={18} />
                  <span>{question.likes}</span>
                </div>
                <div className="icon-with-count">
                  <Repeat size={18} />
                  <span>{question.shares}</span>
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
                      <div onClick={() => { setVisibility('Public'); setIsDropdownOpen(false); }}>Public</div>
                      <div onClick={() => { setVisibility('Anon'); setIsDropdownOpen(false); }}>Anon</div>
                      <div onClick={() => { setVisibility('Private'); setIsDropdownOpen(false); }}>Private</div>
                    </div>
                  )}
                </div>
              </div>
              <div className={`qp-slide ${!showResponses && !isAnimating ? 'collapsed-slide' : ''}`}>
                <div className="response-list">
                  {responses.length > 0 ? (
                    responses.map(response => (
                      <div
                        key={response.id}
                        className="response-item clickable"
                        onClick={() => navigate(`/answer/${response.id}`, {
                          state: {
                            questionText: question.text,
                            answerText: response.text,
                            authorName: response.username,
                            date: 'Just now' // Placeholder
                          }
                        })}
                      >
                        <p className="response-text">{response.text}</p>
                        <span className="response-user">- {response.username}</span>
                      </div>
                    ))
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
            disabled={questionIndex === mockQuestions.length - 1}
          >
            <ChevronRight size={24} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuestionPage;
