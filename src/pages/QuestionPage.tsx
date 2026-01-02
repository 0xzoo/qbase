import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { MessageCircle, MessageCircleDashed, Repeat, Share, Pencil, Eye, ChevronRight, ChevronDown, Heart, RefreshCw } from 'lucide-react';
import Header from '../components/Header';
import QuestionRenderer from '../components/QuestionRenderer';
import SignerSetupModal from '../components/SignerSetupModal';
import Toast from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { useUserSettings } from '../hooks/useUserSettings';
import { useQuestion } from '../hooks/useQuestions';
import { useAnswers } from '../hooks/useAnswers';
import { useQuestions } from '../hooks/useQuestions';
import { useToast } from '../hooks/useToast';
import type { Audiences, Answer, AnswerWFname } from '../lib/types';
import './QuestionPage.css';

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, updateDefaultAudience } = useUserSettings();
  const { user, hasSigner, activeSigner } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  
  // Initialize visibility from settings, with fallback to 'Private'
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showResponses, setShowResponses] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [castCheckComplete, setCastCheckComplete] = useState(false);
  const [showCastRetry, setShowCastRetry] = useState(false);
  const [isRetryingCast, setIsRetryingCast] = useState(false);

  const { question, loading: questionLoading, refetch: refetchQuestion } = useQuestion(id);
  const { answers, loading: answersLoading, refetch: refetchAnswers } = useAnswers({ queryId: id });
  const { questions: allQuestions } = useQuestions({ limit: 100 });

  const questionIndex = question ? allQuestions.findIndex(q => q.id === question.id) : -1;
  const responses = answers as (Answer | AnswerWFname)[];

  // Check if this is a newly created question (coming from CreateQueryModal)
  const isNewQuestion = location.state?.isNewQuestion === true;

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

  // Monitor cast status for newly created questions
  useEffect(() => {
    if (!isNewQuestion || !question || castCheckComplete) return;

    // Wait 6 seconds for background cast to complete
    const checkTimer = setTimeout(async () => {
      // Refetch question to get latest cast_hash
      await refetchQuestion();
      
      // Check again after refetch
      const checkCastStatus = async () => {
        const response = await fetch(`/api/queries/${id}`);
        if (response.ok) {
          const data = await response.json();
          if (!data.casthash) {
            setShowCastRetry(true);
            showToast(
              'This question couldn\'t be posted to Farcaster, but it\'s live on qbase!',
              'warning',
              8000
            );
          } else {
            showToast('Question posted to Farcaster successfully!', 'success');
          }
        }
        setCastCheckComplete(true);
      };

      await checkCastStatus();
    }, 6000);

    return () => clearTimeout(checkTimer);
  }, [isNewQuestion, question, id, castCheckComplete, refetchQuestion, showToast]);

  const handleRetryCast = async () => {
    if (!question || !activeSigner) return;

    setIsRetryingCast(true);
    try {
      const response = await fetch('/api/farcaster/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerUuid: activeSigner.signer_uuid,
          text: question.stem,
          embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
          entityType: 'query',
          entityId: question.id,
        }),
      });

      if (response.ok) {
        showToast('Successfully posted to Farcaster!', 'success');
        setShowCastRetry(false);
        await refetchQuestion();
      } else {
        showToast('Failed to post to Farcaster. Please try again later.', 'error');
      }
    } catch (error) {
      console.error('Error retrying cast:', error);
      showToast('Failed to post to Farcaster. Please try again later.', 'error');
    } finally {
      setIsRetryingCast(false);
    }
  };

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
          
          // FIP-2 Fallback: Use parent_url if question has no cast_hash
          const castPayload = question.casthash
            ? {
                // Primary: Reply to cast
                signerUuid: activeSigner.signer_uuid,
                text: castText,
                embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                parent: question.casthash,              // Reply to question's cast
                parentAuthorFid: question.coiner_fid,  // Question author's FID
                entityType: 'answer',
                entityId: result.answerId,
              }
            : {
                // Fallback: Reply to URL via FIP-2
                signerUuid: activeSigner.signer_uuid,
                text: castText,
                embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                parentUrl: `${window.location.origin}/question/${question.id}`,
                entityType: 'answer',
                entityId: result.answerId,
              };
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(castPayload),
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
          
          // FIP-2 Fallback: Use parent_url if question has no cast_hash
          const castPayload = question.casthash
            ? {
                // Primary: Reply to cast
                useAnonBot: true,
                text: castText,
                embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                parent: question.casthash,
                parentAuthorFid: question.coiner_fid,
                entityType: 'answer',
                entityId: result.answerId,
              }
            : {
                // Fallback: Reply to URL via FIP-2
                useAnonBot: true,
                text: castText,
                embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                parentUrl: `${window.location.origin}/question/${question.id}`,
                entityType: 'answer',
                entityId: result.answerId,
              };
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(castPayload),
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
    <div className="question-page-wrapper" {...handlers} style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Toast notifications */}
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => removeToast(toast.id)}
        />
      ))}

      <Header
        showBack
        backLabel={isExternalEntry ? 'Feed' : 'Back'}
        onBack={isExternalEntry ? () => navigate('/questions') : undefined}
      />

      <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%' }}>
        <div className={`question-content ${animationClass}`} key={id}>
          <div className="question-text-container">
            <h1 className="qp-question-text">{question.stem}</h1>
            
            {/* Cast retry button */}
            {showCastRetry && (
              <button 
                className="retry-cast-btn"
                onClick={handleRetryCast}
                disabled={isRetryingCast}
                title="Retry posting to Farcaster"
              >
                <RefreshCw size={14} className={isRetryingCast ? 'spin' : ''} />
                {isRetryingCast ? 'Posting...' : 'Retry Farcaster Post'}
              </button>
            )}
          </div>

          <div className="qp-metadata">
            <span className="coined-by">
              coined by <Link to={`/ask/${question.coiner_fname || 'anonymous'}`}>@{question.coiner_fname || 'anonymous'}</Link>
            </span>
            <div className="qp-actions">
              <div className="qp-action-left">
                <Pencil size={18} className="icon-btn" onClick={() => setShowResponses(false)} />
                <div
                  className={`icon-with-count ${showResponses ? 'active' : ''}`}
                  onClick={() => setShowResponses(true)}
                  style={{ cursor: 'pointer' }}
                  title="Public answers"
                >
                  <MessageCircle size={18} />
                  <span>{question.pub_answers || 0}</span>
                </div>
                <div className="icon-with-count" title="Private answers">
                  <MessageCircleDashed size={18} />
                  <span>{question.priv_answers || 0}</span>
                </div>
                <div className="icon-with-count" title="Likes" style={{ cursor: 'pointer' }}>
                  <Heart size={18} />
                  <span>{question.farcaster_likes || 0}</span>
                </div>
                <div className="icon-with-count" title="Recasts" style={{ cursor: 'pointer' }}>
                  <Repeat size={18} />
                  <span>{question.farcaster_recasts || 0}</span>
                </div>
              </div>
              <div className="qp-action-right">
              {question.casthash && (
                <a 
                  href={`https://farcaster.xyz/${question.coiner_fname}/${question.casthash.substring(0, 10)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="icon-btn"
                  title="View on Farcaster"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 22 20" fill="none">
                    <title>Farcaster logo</title>
                    <g fill="currentColor" clipPath="url(#a)">
                      <path d="M3.786.05h14.156v2.824h4.025l-.844 2.825h-.714v11.427c.358 0 .65.287.65.642v.77h.13c.358 0 .649.288.649.642v.77h-7.273v-.77c0-.354.29-.642.65-.642h.13v-.77c0-.309.22-.566.512-.628l-.014-6.306c-.23-2.519-2.37-4.493-4.98-4.493-2.608 0-4.75 1.974-4.979 4.494l-.013 6.3c.346.05.772.315.772.633v.77h.13c.358 0 .65.288.65.642v.77H.15v-.77c0-.354.29-.642.649-.642h.13v-.77c0-.355.29-.642.65-.642V5.7H.863L.02 2.874h3.766V.05Z"></path>
                    </g>
                    <defs>
                      <clipPath id="a">
                        <path fill="currentColor" d="M0 0h22v20H0z"></path>
                      </clipPath>
                    </defs>
                  </svg>
                </a>
              )}
              <Share size={18} className="icon-btn" />
              </div>
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
