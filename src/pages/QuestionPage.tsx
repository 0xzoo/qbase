import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { MessageCircle, MessageCircleDashed, Share, Eye, ChevronRight, ChevronDown, RefreshCw, Plus, X } from 'lucide-react';
import Header from '../components/Header';
import QuestionRenderer from '../components/QuestionRenderer';
import SignerSetupModal from '../components/SignerSetupModal';
import Toast from '../components/Toast';
import { LikeButton } from '../components/LikeButton';
import { RecastButton } from '../components/RecastButton';
import CompactAnswerCard from '../components/CompactAnswerCard';
import { useAuth } from '../context/AuthContext';
import { useUserSettings } from '../hooks/useUserSettings';
import { useQuestion } from '../hooks/useQuestions';
import { useAnswers, useUserAnswerForQuestion } from '../hooks/useAnswers';
import { useQuestions } from '../hooks/useQuestions';
import { useToast } from '../hooks/useToast';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences, Answer, AnswerWFname } from '../lib/types';
import './QuestionPage.css';

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, updateDefaultAudience } = useUserSettings();
  const { user, hasSigner, activeSigner, getAuthToken } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  
  // Initialize visibility from settings, with fallback to 'Private'
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showAnswerModal, setShowAnswerModal] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [castCheckComplete, setCastCheckComplete] = useState(false);
  const [showCastRetry, setShowCastRetry] = useState(false);
  const [isRetryingCast, setIsRetryingCast] = useState(false);
  const [existingAnswerId, setExistingAnswerId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const { question, loading: questionLoading, refetch: refetchQuestion } = useQuestion(id);
  const { answers, loading: answersLoading, refetch: refetchAnswers } = useAnswers({ queryId: id });
  const { questions: allQuestions } = useQuestions({ limit: 100 });
  
  // Fetch Farcaster replies and fresh engagement data if question has a casthash
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    question?.casthash,
    user?.fid
  );
  
  // Use fresh Farcaster engagement data when available, fall back to DB values
  const displayLikes = farcasterEngagement?.likes_count ?? question?.farcaster_likes ?? 0;
  const displayRecasts = farcasterEngagement?.recasts_count ?? question?.farcaster_recasts ?? 0;
  
  // Fetch user's existing answer for this question (using FID, server will resolve to internal ID)
  const userFid = user?.fid;
  const { data: userAnswerData, loading: userAnswerLoading } = useUserAnswerForQuestion(userFid, id);

  const questionIndex = question ? allQuestions.findIndex(q => q.id === question.id) : -1;
  const responses = answers as (Answer | AnswerWFname)[];

  // Check if this is a newly created question (coming from CreateQueryModal)
  const isNewQuestion = location.state?.isNewQuestion === true;

  // Update visibility when settings or question load
  // For knowledge questions, default to Public (knowledge is meant to be shared)
  useEffect(() => {
    if (question?.taxonomy?.primary_type === 'knowledge') {
      setVisibility('Public');
    } else if (settings?.defaultAudience) {
      setVisibility(settings.defaultAudience);
    }
  }, [settings, question]);

  useEffect(() => {
    // Reset state when question ID changes
    setIsDropdownOpen(false);
    setAnswerValue(null);
    setShowAnswerModal(false);
    setExistingAnswerId(null);
    setIsUpdating(false);
    
    // Reset visibility based on question type (will be set properly by the other useEffect once question loads)
    // For now, use user's default
    if (settings?.defaultAudience) {
      setVisibility(settings.defaultAudience);
    }

    if (location.state && location.state.direction) {
      setAnimationClass(location.state.direction === 'next' ? 'slide-in-right' : 'slide-in-left');
    } else {
      setAnimationClass('');
    }
  }, [id, location.state, settings?.defaultAudience]);

  // Pre-populate answer for identity questions when user answer data loads
  useEffect(() => {
    if (!userAnswerData || userAnswerLoading) return;

    // For identity questions with an existing answer
    if (userAnswerData.primary_type === 'identity' && userAnswerData.answer) {
      const answer = userAnswerData.answer;
      
      // Extract the actual value (handle encrypted format)
      const actualValue = typeof answer.value === 'string' ? answer.value : String(answer.value);
      
      // Pre-populate the answer value based on question type
      if (question?.type === 'mc' && answer.q_index !== undefined) {
        setAnswerValue(answer.q_index);
      } else if (question?.type === 'scale') {
        setAnswerValue(parseInt(actualValue));
      } else {
        setAnswerValue(actualValue);
      }

      // Set the audience dropdown to match their previous answer
      setVisibility(answer.audience as Audiences);

      // Mark as updating (not creating)
      setIsUpdating(true);
      setExistingAnswerId(answer.id);
    }
  }, [userAnswerData, userAnswerLoading, question]);

  // Sort answers with user's own answers at the top
  const sortedResponses = useMemo(() => {
    if (!responses) return [];
    
    const userAnswerIds = new Set<string>();
    
    if (userAnswerData) {
      // Collect user's answer IDs (identity questions)
      if (userAnswerData.answer) {
        userAnswerIds.add(userAnswerData.answer.id);
      }
      // Collect user's answer IDs (temporal questions)
      if (userAnswerData.answers) {
        userAnswerData.answers.forEach((a: Answer) => userAnswerIds.add(a.id));
      }
    }
    
    // Sort: user's answers first, then others by date
    return [...responses].sort((a, b) => {
      const aIsUser = userAnswerIds.has(a.id) || ('is_own_anon' in a && a.is_own_anon);
      const bIsUser = userAnswerIds.has(b.id) || ('is_own_anon' in b && b.is_own_anon);
      
      if (aIsUser && !bIsUser) return -1;
      if (!aIsUser && bIsUser) return 1;
      
      // Both user's or both not - sort by date descending
      return b.created_at - a.created_at;
    });
  }, [responses, userAnswerData]);

  // Filter Farcaster replies to remove duplicates (replies that are also qbase answers)
  // Duplicates are identified by:
  // 1. Same Farcaster user FID as a qbase answer author
  // 2. Matching cast hash (if answer has a casthash)
  const filteredFarcasterReplies = useMemo(() => {
    if (!farcasterReplies || farcasterReplies.length === 0) return [];
    
    // Collect FIDs and cast hashes from qbase answers
    const qbaseAuthorFids = new Set<number>();
    const qbaseCastHashes = new Set<string>();
    
    responses.forEach((answer) => {
      // Get the user FID from the answer
      const userFid = 'user_fid' in answer ? answer.user_fid as number : undefined;
      if (userFid) {
        qbaseAuthorFids.add(userFid);
      }
      // Get the cast hash if the answer was cast
      if ('casthash' in answer && answer.casthash) {
        qbaseCastHashes.add(answer.casthash as string);
      }
    });
    
    // Filter out replies that are duplicates
    return farcasterReplies.filter((reply) => {
      // Check if this reply's hash matches any qbase answer cast hash
      if (qbaseCastHashes.has(reply.hash)) {
        return false;
      }
      // Check if author FID matches any qbase answer author
      // This catches cases where someone answered via qbase (which casts as reply)
      if (qbaseAuthorFids.has(reply.author.fid)) {
        return false;
      }
      return true;
    });
  }, [farcasterReplies, responses]);

  // Sync answer counts if they appear to be out of sync
  // This fixes counts that were reset during the Nillion update
  useEffect(() => {
    const syncCounts = async () => {
      if (!question || !id) return;
      
      // Check if counts might be out of sync:
      // - We have answers displayed but pub_answers shows 0
      // - OR we have farcaster replies but no answer counts
      const hasVisibleAnswers = sortedResponses.length > 0;
      const countsAreZero = (question.pub_answers || 0) === 0 && (question.priv_answers || 0) === 0;
      
      if (hasVisibleAnswers && countsAreZero) {
        console.log('[Sync Counts] Detected out-of-sync answer counts, triggering sync...');
        try {
          const token = getAuthToken();
          const response = await fetch(`/api/queries/${id}/sync-counts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token && { 'Authorization': `Bearer ${token}` })
            }
          });
          
          if (response.ok) {
            const result = await response.json();
            console.log('[Sync Counts] Successfully synced:', result);
            // Refetch question to get updated counts
            await refetchQuestion();
          } else {
            console.error('[Sync Counts] Sync failed:', response.status);
          }
        } catch (error) {
          console.error('[Sync Counts] Error syncing counts:', error);
        }
      }
    };
    
    // Only run once answers have loaded
    if (!answersLoading) {
      syncCounts();
    }
  }, [question, id, sortedResponses.length, answersLoading, getAuthToken, refetchQuestion]);

  // Monitor cast status for newly created questions
  useEffect(() => {
    if (!isNewQuestion || !question || castCheckComplete) return;

    // Since cast hash is now returned in the create response, we can check immediately
    // Just do one check after a brief delay to let the page load
    const checkTimer = setTimeout(async () => {
      if (!question.casthash) {
        // If no cast hash after creation, show retry option
        setShowCastRetry(true);
        showToast(
          'This question couldn\'t be posted to Farcaster, but it\'s live on qbase!',
          'warning',
          8000
        );
      }
      // Success case: silently succeed, no toast needed
      setCastCheckComplete(true);
    }, 1000); // Just 1 second to let page load

    return () => clearTimeout(checkTimer);
  }, [isNewQuestion, question, castCheckComplete, showToast]);

  const handleRetryCast = async () => {
    if (!question || !activeSigner) return;

    setIsRetryingCast(true);
    console.log('[Retry Cast] Starting retry cast for question:', question.id);
    console.log('[Retry Cast] Signer UUID:', activeSigner.signer_uuid);
    
    try {
      const token = getAuthToken();
      const castPayload = {
        signerUuid: activeSigner.signer_uuid,
        text: question.stem,
        // Removed embeds for now - may add back later
        entityType: 'query',
        entityId: question.id,
      };
      
      console.log('[Retry Cast] Cast payload:', castPayload);
      
      const response = await fetch('/api/farcaster/cast', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify(castPayload),
      });

      console.log('[Retry Cast] Response status:', response.status);
      
      if (response.ok) {
        const result = await response.json();
        console.log('[Retry Cast] Success:', result);
        showToast('Successfully posted to Farcaster!', 'success');
        setShowCastRetry(false);
        await refetchQuestion();
      } else {
        const errorText = await response.text();
        console.error('[Retry Cast] Failed with status:', response.status);
        console.error('[Retry Cast] Error response:', errorText);
        showToast('Failed to post to Farcaster. Please try again later.', 'error');
      }
    } catch (error) {
      console.error('[Retry Cast] Exception occurred:', error);
      console.error('[Retry Cast] Error details:', error instanceof Error ? error.message : String(error));
      showToast('Failed to post to Farcaster. Please try again later.', 'error');
    } finally {
      setIsRetryingCast(false);
    }
  };

  const handleLikeError = (error: string) => {
    showToast(error, 'error');
  };

  const handleRecastError = (error: string) => {
    showToast(error, 'error');
  };

  const handleSwipe = (direction: string) => {
    if (direction === 'Left') {
      // Next question
      if (questionIndex >= 0 && questionIndex < allQuestions.length - 1) {
        navigate(`/question/${allQuestions[questionIndex + 1].id}`, {
          state: { direction: 'next' },
          replace: true
        });
      }
    } else if (direction === 'Right') {
      // Previous question
      if (questionIndex > 0) {
        navigate(`/question/${allQuestions[questionIndex - 1].id}`, {
          state: { direction: 'prev' },
          replace: true
        });
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

  // Handle answer save or update
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

      const token = getAuthToken();

      // If updating an existing identity answer, use PUT
      if (isUpdating && existingAnswerId) {
        const updatePayload = {
          value: String(processedValue),
          answer_type_id: answerTypeId,
          audience: visibility,
          ...(qIndex !== undefined && { q_index: qIndex }),
        };

        const response = await fetch(`/api/answers/${existingAnswerId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
          },
          body: JSON.stringify(updatePayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to update answer: ${errorText}`);
        }

        const result = await response.json();
        console.log('Answer updated:', result);

        // Refetch answers to show the updated one
        await refetchAnswers();

        // Show success feedback
        alert('Answer updated successfully!');
      } else {
        // Creating a new answer (temporal or first-time identity)
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
            ...(token && { 'Authorization': `Bearer ${token}` })
          },
          body: JSON.stringify(answerPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to save answer: ${errorText}`);
        }

        const result = await response.json();
        console.log('Answer saved:', result);

        // Cast to Farcaster based on visibility (only for new answers, not updates)
        if (visibility === 'Public' && activeSigner) {
        // Public answer: cast from user's account
        console.log('[Public Answer Cast] Starting cast for answer:', result.answerId);
        console.log('[Public Answer Cast] Question has casthash?', !!question.casthash);
        
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
          
          console.log('[Public Answer Cast] Payload:', castPayload);
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token && { 'Authorization': `Bearer ${token}` }),
            },
            body: JSON.stringify(castPayload),
          });

          console.log('[Public Answer Cast] Response status:', castResponse.status);

          if (castResponse.ok) {
            const castResult = await castResponse.json();
            console.log('[Public Answer Cast] Success:', castResult);
          } else {
            const errorText = await castResponse.text();
            console.error('[Public Answer Cast] Failed with status:', castResponse.status);
            console.error('[Public Answer Cast] Error response:', errorText);
          }
        } catch (castError) {
          console.error('[Public Answer Cast] Exception occurred:', castError);
          console.error('[Public Answer Cast] Error details:', castError instanceof Error ? castError.message : String(castError));
          // Don't fail the whole operation if cast fails
        }
      } else if (visibility === 'Anon') {
        // Anonymous answer: cast from anon bot (@4n0n)
        console.log('[Anon Answer Cast] Starting cast for answer:', result.answerId);
        console.log('[Anon Answer Cast] Question has casthash?', !!question.casthash);
        
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
          
          console.log('[Anon Answer Cast] Payload:', castPayload);
          
          const castResponse = await fetch('/api/farcaster/cast', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token && { 'Authorization': `Bearer ${token}` }),
            },
            body: JSON.stringify(castPayload),
          });

          console.log('[Anon Answer Cast] Response status:', castResponse.status);

          if (castResponse.ok) {
            const castResult = await castResponse.json();
            console.log('[Anon Answer Cast] Success:', castResult);
          } else {
            const errorText = await castResponse.text();
            console.error('[Anon Answer Cast] Failed with status:', castResponse.status);
            console.error('[Anon Answer Cast] Error response:', errorText);
          }
        } catch (castError) {
          console.error('[Anon Answer Cast] Exception occurred:', castError);
          console.error('[Anon Answer Cast] Error details:', castError instanceof Error ? castError.message : String(castError));
          // Don't fail the whole operation if cast fails
        }
      }

      // Refetch answers to show the new one
      await refetchAnswers();

      // Reset the form (don't reset for identity updates as they may want to edit again)
      if (!isUpdating) {
        setAnswerValue(null);
      }
      
      // Show success feedback
      alert('Answer saved successfully!');
    }
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
                <div className="icon-with-count" title="Public answers">
                  <MessageCircle size={18} />
                  <span>{question.pub_answers || 0}</span>
                </div>
                <div className="icon-with-count" title="Private answers">
                  <MessageCircleDashed size={18} />
                  <span>{question.priv_answers || 0}</span>
                </div>
                <LikeButton
                  castHash={question.casthash}
                  initialLiked={question.user_has_liked || false}
                  initialCount={displayLikes}
                  showCount={true}
                  size={18}
                  className="icon-with-count"
                  onError={handleLikeError}
                />
                <RecastButton
                  castHash={question.casthash}
                  initialRecasted={question.user_has_recasted || false}
                  initialCount={displayRecasts}
                  showCount={true}
                  size={18}
                  className="icon-with-count"
                  onError={handleRecastError}
                />
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

          {/* Answers List */}
          <div className="qp-answers-container">
            <div className="response-list">
              {answersLoading ? (
                <div className="loading-spinner">Loading answers...</div>
              ) : sortedResponses.length > 0 ? (
                sortedResponses.map(response => {
                  const answerText = typeof response.value === 'string' 
                    ? response.value 
                    : JSON.stringify(response.value);
                  
                  // Check if this is user's own answer
                  const isOwnAnswer = userAnswerData?.answer?.id === response.id ||
                    userAnswerData?.answers?.some((a: Answer) => a.id === response.id) ||
                    ('is_own_anon' in response && response.is_own_anon);
                  const isOwnAnon = 'is_own_anon' in response && response.is_own_anon;
                  
                  const authorName = ('user_fname' in response && response.user_fname) 
                    ? (response.user_fname as string)
                    : '4n0n';
                  
                  const authorFid = 'user_fid' in response ? (response.user_fid as number) : undefined;
                  const avatarUrl = 'user_pfp' in response ? (response.user_pfp as string) : undefined;
                  
                  return (
                    <CompactAnswerCard
                      key={response.id}
                      id={response.id}
                      answerText={answerText}
                      authorName={authorName}
                      authorFid={authorFid}
                      avatarUrl={avatarUrl}
                      isOwnAnswer={isOwnAnswer}
                      isAnonymous={isOwnAnon || authorName === '4n0n'}
                      createdAt={response.created_at}
                      questionText={question.stem}
                    />
                  );
                })
              ) : (
                <div className="no-responses">No responses yet. Be the first to answer!</div>
              )}
              
              {/* Show "See X more" link for recurring questions with multiple user answers */}
              {userAnswerData && 
               (userAnswerData.primary_type === 'recurring' || userAnswerData.primary_type === 'prospective') && 
               userAnswerData.count && userAnswerData.count > 1 && (
                <div className="see-more-answers">
                  <Link to={`/my-answers?q_id=${id}`}>
                    See {userAnswerData.count - 1} more of your answers
                  </Link>
                </div>
              )}
              
              {/* Farcaster Replies Section */}
              {repliesLoading && question?.casthash && (
                <div className="loading-spinner farcaster-replies-loading">Loading Farcaster replies...</div>
              )}
              
              {filteredFarcasterReplies.length > 0 && (
                <>
                  <div className="farcaster-replies-divider">
                    <span className="divider-line"></span>
                    <span className="divider-text">Replies from Farcaster</span>
                    <span className="divider-line"></span>
                  </div>
                  {filteredFarcasterReplies.map((reply: FarcasterReply) => (
                    <CompactAnswerCard
                      key={`fc-${reply.hash}`}
                      id={reply.hash}
                      answerText={reply.text}
                      authorName={reply.author.username}
                      authorFid={reply.author.fid}
                      avatarUrl={reply.author.pfp_url}
                      isOwnAnswer={reply.author.fid === user?.fid}
                      isAnonymous={false}
                      createdAt={new Date(reply.timestamp).getTime()}
                      questionText={question.stem}
                      onClick={() => {
                        // Open Farcaster reply in new tab
                        window.open(
                          `https://warpcast.com/${reply.author.username}/${reply.hash.substring(0, 10)}`,
                          '_blank'
                        );
                      }}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Navigation buttons */}
        {/* <div className="qp-nav-buttons">
          {questionIndex > 0 && (
            <button
              className="nav-btn prev-btn"
              onClick={() => handleSwipe('Right')}
              title="Previous question"
            >
              <ChevronRight size={24} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
          {questionIndex >= 0 && questionIndex < allQuestions.length - 1 && (
            <button
              className="nav-btn next-btn"
              onClick={() => handleSwipe('Left')}
              title="Next question"
            >
              <ChevronRight size={24} />
            </button>
          )}
        </div> */}

        {/* Floating Action Button for answering */}
        <button
          className="answer-fab"
          onClick={() => setShowAnswerModal(true)}
          title="Add your answer"
        >
          <Plus size={24} />
        </button>
      </div>

      {/* Answer Modal */}
      {showAnswerModal && (
        <div className="answer-modal-overlay" onClick={() => setShowAnswerModal(false)}>
          <div className="answer-modal" onClick={e => e.stopPropagation()}>
            <div className="answer-modal-header">
              <h3>{isUpdating ? 'Update your answer' : 'Add your answer'}</h3>
              <button className="close-modal-btn" onClick={() => setShowAnswerModal(false)}>
                <X size={20} />
              </button>
            </div>
            
            <div className="answer-modal-content">
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
            
            <div className="answer-modal-footer">
              <button
                className={`save-answer-btn ${isAnswerValid() ? 'active' : ''}`}
                disabled={!isAnswerValid() || isSaving}
                onClick={async () => {
                  await handleSaveAnswer();
                  if (!isSaving) setShowAnswerModal(false);
                }}
              >
                {isSaving ? 'Saving...' : isUpdating ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action={visibility === 'Public' || visibility === 'Anon' ? "share your answer to Farcaster" : "like content on Farcaster"}
        customMessage={
          visibility === 'Public' || visibility === 'Anon'
            ? `To share ${visibility === 'Public' ? 'public' : 'anonymous'} answers to Farcaster, you need to authorize qbase to post on your behalf.`
            : 'To like content on Farcaster, you need to authorize qbase to interact on your behalf.'
        }
      />
    </div>
  );
};

export default QuestionPage;
