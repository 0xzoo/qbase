import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { MessageCircle, MessageCircleDashed, Repeat, Share, Pencil, Eye, ChevronRight, ChevronDown, Heart } from 'lucide-react';
import Header from '../components/Header';
import QuestionRenderer from '../components/QuestionRenderer';
import SignerSetupModal from '../components/SignerSetupModal';
import { useAuth } from '../context/AuthContext';
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
  const { user, hasSigner, activeSigner } = useAuth();
  
  // Initialize visibility from settings, with fallback to 'Private'
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showResponses, setShowResponses] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const { question, loading: questionLoading } = useQuestion(id);
  const { answers, loading: answersLoading, refetch: refetchAnswers } = useAnswers({ queryId: id });
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

  // Handle answer save
  const handleSaveAnswer = async () => {
    if (!isAnswerValid() || !user || !question) return;

    // Check if user needs a signer for Public answers only (Anon uses bot)
    const needsUserSigner = visibility === 'Public';
    if (needsUserSigner && !hasSigner) {
      setShowSignerModal(true);
      return;
    }

    setIsSaving(true);

    try {
      // Determine answer type based on question type and answer value
      let answerTypeId = 'text';
      let processedValue = answerValue;
      let qIndex: number | undefined;

      if (question.type === 'mc' && typeof answerValue === 'number') {
        answerTypeId = 'multiple_choice';
        qIndex = answerValue;
        // Get the text value from the options
        if (question.a_options && question.a_options[answerValue]) {
          processedValue = question.a_options[answerValue];
        }
      } else if (question.type === 'scale' && typeof answerValue === 'number') {
        answerTypeId = 'scale';
        qIndex = answerValue;
        processedValue = answerValue.toString();
      } else if (typeof answerValue === 'boolean') {
        answerTypeId = 'boolean';
        processedValue = answerValue.toString();
      } else if (typeof answerValue === 'number') {
        answerTypeId = 'number';
        processedValue = answerValue.toString();
      } else {
        // Default to text
        processedValue = String(answerValue);
      }

      // Create the answer payload
      // Note: user_id is injected by the server from authenticated user
      const answerPayload = {
        q_id: question.id,
        value: String(processedValue),
        answer_type_id: answerTypeId,
        audience: visibility,
        ...(qIndex !== undefined && { q_index: qIndex }),
      };

      const response = await fetch('/api/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(answerPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to save answer: ${errorText}`);
      }

      const result = await response.json();
      console.log('Answer saved:', result);

      // Cast to Farcaster based on visibility
      if (visibility === 'Public' && activeSigner) {
        // Public answer: cast from user's account
        try {
          const castText = `${question.stem}\n\nMy answer: ${processedValue}`;
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              signerUuid: activeSigner.signer_uuid,
              text: castText,
              embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
              parent: question.casthash,              // Reply to question's cast
              parentAuthorFid: question.coiner_fid,  // Question author's FID
              entityType: 'answer',                  // Store cast with answer entity
              entityId: result.answerId,             // Answer ID from API response
            }),
          });

          if (castResponse.ok) {
            const castResult = await castResponse.json();
            console.log('Cast published from user account:', castResult);
          } else {
            console.error('Failed to cast to Farcaster, but answer was saved');
          }
        } catch (castError) {
          console.error('Error casting to Farcaster:', castError);
          // Don't fail the whole operation if cast fails
        }
      } else if (visibility === 'Anon') {
        // Anonymous answer: cast from anon bot (@4n0n)
        try {
          const castText = `${question.stem}\n\nAnswered anonymously via @qbase`;
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              useAnonBot: true,  // Use anon bot instead of user's signer
              text: castText,
              embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
              parent: question.casthash,              // Reply to question's cast
              parentAuthorFid: question.coiner_fid,  // Question author's FID
              entityType: 'answer',                  // Store cast with answer entity
              entityId: result.answerId,             // Answer ID from API response
            }),
          });

          if (castResponse.ok) {
            const castResult = await castResponse.json();
            console.log('Cast published from anon bot:', castResult);
          } else {
            console.error('Failed to cast anonymously, but answer was saved');
          }
        } catch (castError) {
          console.error('Error casting anonymously:', castError);
          // Don't fail the whole operation if cast fails
        }
      }

      // Refetch answers to show the new one
      await refetchAnswers();

      // Reset the form
      setAnswerValue(null);
      
      // Show success feedback
      alert('Answer saved successfully!');
    } catch (error) {
      console.error('Error saving answer:', error);
      alert(error instanceof Error ? error.message : 'Failed to save answer');
    } finally {
      setIsSaving(false);
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
                        ? (response.user_fname as string)
                        : '4n0n';
                      
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
            disabled={!isAnswerValid() || isSaving}
            onClick={handleSaveAnswer}
          >
            {isSaving ? 'Saving...' : 'Save'}
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

      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="share your answer to Farcaster"
        customMessage={`To share ${visibility === 'Public' ? 'public' : 'anonymous'} answers to Farcaster, you need to authorize qbase to post on your behalf.`}
      />
    </div>
  );
};

export default QuestionPage;
