import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { MessageCircle, MessageCircleDashed, Share, Eye, ChevronDown, RefreshCw, X, ChartColumn } from 'lucide-react';
import QuestionRenderer from './QuestionRenderer';
import SignerSetupModal from './SignerSetupModal';
import WalletConnectModal from './WalletConnectModal';
import Toast from './Toast';
import { LikeButton } from './LikeButton';
import { RecastButton } from './RecastButton';
import CompactAnswerCard from './CompactAnswerCard';
import LoadingAnimation from './LoadingAnimation';
import QuestionAnalyticsModal from './QuestionAnalyticsModal';
import { useAuth } from '../context/AuthContext';
import { useUserSettings } from '../hooks/useUserSettings';
import { useAnswers, useUserAnswerForQuestion } from '../hooks/useAnswers';
import { useToast } from '../hooks/useToast';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import { usePrivateAnswerSubmit } from '../hooks/usePrivateAnswerSubmit';
import { useUserAnswerWithE2E } from '../hooks/usePrivateAnswerRead';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences, Answer, AnswerWFname, Query, CheckboxAnswerValue, AnswerData } from '../lib/types';
import { AnswerTypeId } from '../lib/types';
import type { ScaleConfig } from '../lib/types';
import { MAX_A_LENGTH } from '../lib/consts';
import './QuestionSlide.css';

/**
 * Generates a human-readable label for a scale value.
 * 5-point: [X, Leaning X, Neutral, Leaning Y, Y]
 * 7-point: [X, Mostly X, Leaning X, Neutral, Leaning Y, Mostly Y, Y]
 */
function getScaleLabel(value: number, config: ScaleConfig): string {
  const { min, max, minLabel, maxLabel, customLabels } = config;
  
  // Check for custom label first
  if (customLabels) {
    const custom = customLabels.find(c => c.value === value);
    if (custom) return custom.label;
  }
  
  const range = max - min + 1;
  const position = value - min; // 0-indexed position
  const midpoint = (range - 1) / 2;
  
  // Fallback labels if not provided
  const labelMin = minLabel || String(min);
  const labelMax = maxLabel || String(max);
  
  // Exact endpoints
  if (value === min) return labelMin;
  if (value === max) return labelMax;
  
  // Exact midpoint (neutral)
  if (position === midpoint) return 'Neutral';
  
  // Determine which side and intensity
  const isLowerHalf = position < midpoint;
  const baseLabel = isLowerHalf ? labelMin : labelMax;
  const distanceFromEnd = isLowerHalf ? position : (range - 1 - position);
  
  // For 5-point scale: positions are 0,1,2,3,4 → distances from ends are 0,1,2,1,0
  // For 7-point scale: positions are 0,1,2,3,4,5,6 → distances 0,1,2,3,2,1,0
  if (distanceFromEnd === 1) {
    return range >= 7 ? `Mostly ${baseLabel}` : `Leaning ${baseLabel}`;
  }
  if (distanceFromEnd === 2) {
    return `Leaning ${baseLabel}`;
  }
  
  // Fallback for larger scales
  return `${baseLabel} (${value})`;
}

interface QuestionSlideProps {
  question: Query;
  isActive: boolean;
  onRetryCast?: () => void;
  isRetryingCast?: boolean;
  showCastRetry?: boolean;
  isCastPending?: boolean;
}

const QuestionSlide: React.FC<QuestionSlideProps> = ({
  question,
  isActive,
  onRetryCast,
  isRetryingCast = false,
  showCastRetry = false,
  isCastPending = false,
}) => {
  const { settings, updateDefaultAudience } = useUserSettings();
  const { user, hasSigner, activeSigner, getAuthToken } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  
  // E2E encryption for private answers
  const { 
    submitPrivateAnswer, 
    needsWalletConnection, 
    needsKeyDerivation,
    isSubmitting: isE2ESubmitting,
  } = usePrivateAnswerSubmit();
  
  // State
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showAnswerModal, setShowAnswerModal] = useState(false);
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [existingAnswerId, setExistingAnswerId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  

  // Lazy load data only when slide is active or nearby
  const { answers, loading: answersLoading, refetch: refetchAnswers } = useAnswers({ 
    queryId: isActive ? question.id : undefined 
  });
  
  const userFid = user?.fid;
  const { data: userAnswerData, loading: userAnswerLoading } = useUserAnswerForQuestion(
    isActive ? userFid : undefined, 
    isActive ? question.id : undefined
  );

  // E2E encrypted answers (silently skip if not unlocked)
  const { 
    e2eAnswers, 
    isLoadingE2E,
    canReadE2E,
  } = useUserAnswerWithE2E(
    isActive ? userFid : undefined,
    isActive ? question.id : undefined
  );

  // Fetch Farcaster replies
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    isActive ? question?.casthash : undefined,
    user?.fid
  );

  const responses = answers as (Answer | AnswerWFname)[];

  // Persist Farcaster engagement stats and pub_answers when fresh data is fetched
  useEffect(() => {
    if (!farcasterEngagement || !question?.casthash) return;
    if (answersLoading || repliesLoading) return; // Wait for all data to load
    
    // Only sync if we have actual engagement data
    const { likes_count, recasts_count, replies_count } = farcasterEngagement;
    if (likes_count === undefined && recasts_count === undefined && replies_count === undefined) return;

    // Calculate total pub_answers: qbase answers + Farcaster replies
    const qbaseAnswersCount = responses?.length ?? 0;
    const farcasterRepliesCount = replies_count ?? 0;
    const totalPubAnswers = qbaseAnswersCount + farcasterRepliesCount;

    // Fire-and-forget: persist stats in background
    fetch('/api/farcaster/sync-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        castHash: question.casthash,
        likes_count: likes_count ?? 0,
        recasts_count: recasts_count ?? 0,
        replies_count: replies_count ?? 0,
        pub_answers: totalPubAnswers,
      }),
    }).catch(err => {
      // Silently fail - this is a non-critical background operation
      console.debug('[Farcaster Stats Sync] Failed:', err);
    });
  }, [farcasterEngagement, question?.casthash, responses?.length, answersLoading, repliesLoading]);

  // Display values
  const displayLikes = farcasterEngagement?.likes_count ?? question?.farcaster_likes ?? 0;
  const displayRecasts = farcasterEngagement?.recasts_count ?? question?.farcaster_recasts ?? 0;
  // Use max of qbase answers and Farcaster replies to avoid double counting
  // (public answers with casts appear in both, external FC replies only in Farcaster)
  const farcasterRepliesCount = farcasterEngagement?.replies_count ?? 0;

  // Format stem text
  const displayStem = useMemo(() => {
    if (!question) return '';
    
    const isTemplate = question.taxonomy?.is_template || question.template;
    
    if (isTemplate && question.type === 'mc' && question.a_options && question.a_options.length > 0) {
      const optionsText = question.a_options
        .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
        .join('\n');
      return `${question.stem}\n\n${optionsText}`;
    }
    
    if (isTemplate && question.type === 'scale' && question.scale_config) {
      const { min, max, minLabel, maxLabel } = question.scale_config;
      const scaleText = minLabel && maxLabel 
        ? `(${min} = ${minLabel}, ${max} = ${maxLabel})`
        : `(${min} - ${max})`;
      return `${question.stem}\n\n${scaleText}`;
    }
    
    return question.stem;
  }, [question]);

  // Update visibility when settings load
  useEffect(() => {
    if (question?.taxonomy?.primary_type === 'knowledge') {
      setVisibility('Public');
    } else if (settings?.defaultAudience) {
      setVisibility(settings.defaultAudience);
    }
  }, [settings, question]);

  // Reset state when question changes
  useEffect(() => {
    setIsDropdownOpen(false);
    setAnswerValue(null);
    setShowAnswerModal(false);
    setExistingAnswerId(null);
    setIsUpdating(false);
  }, [question.id]);

  // Pre-populate answer for identity questions (from server or E2E)
  useEffect(() => {
    // Helper to parse structured JSON value and set the appropriate answer state
    const parseAndSetValue = (valueStr: string, questionType: string | undefined) => {
      try {
        const parsed = JSON.parse(valueStr);
        if (questionType === 'mc' && parsed.index !== undefined) {
          // MC answer - look up option text from index
          const optionText = question.a_options?.[parsed.index];
          setAnswerValue(optionText ?? valueStr);
        } else if (questionType === 'checkbox' && parsed.indices) {
          // Checkbox answer - set the full structured value
          setAnswerValue(parsed);
        } else if (questionType === 'scale' && parsed.index !== undefined) {
          setAnswerValue(parsed.index);
        } else if (parsed.text !== undefined) {
          setAnswerValue(parsed.text);
        } else {
          setAnswerValue(valueStr);
        }
      } catch {
        // Not JSON - for scale, try to parse as number (backwards compat)
        if (questionType === 'scale') {
          const numValue = Number(valueStr);
          if (!isNaN(numValue)) {
            setAnswerValue(numValue);
            return;
          }
        }
        setAnswerValue(valueStr);
      }
    };

    // First check server-side answers
    if (userAnswerData && !userAnswerLoading && userAnswerData.primary_type === 'identity' && userAnswerData.answer) {
      const answer = userAnswerData.answer;
      const valueStr = typeof answer.value === 'string' ? answer.value : String(answer.value);
      
      parseAndSetValue(valueStr, question?.type);
      setVisibility(answer.audience as Audiences);
      setIsUpdating(true);
      setExistingAnswerId(answer.id);
      return;
    }

    // If no server answer but we have E2E identity answer, pre-populate
    if (!userAnswerLoading && !isLoadingE2E && e2eAnswers.length > 0) {
      const identityAnswer = e2eAnswers.find(a => a.primary_type === 'identity');
      if (identityAnswer) {
        const valueStr = typeof identityAnswer.value === 'string' ? identityAnswer.value : String(identityAnswer.value);
        
        parseAndSetValue(valueStr, question?.type);
        setVisibility(identityAnswer.audience as Audiences);
        setIsUpdating(true);
        setExistingAnswerId(identityAnswer.id);
      }
    }
  }, [userAnswerData, userAnswerLoading, question, e2eAnswers, isLoadingE2E]);

  // Sort answers with user's own at the top (including E2E answers)
  const sortedResponses = useMemo(() => {
    const userAnswerIds = new Set<string>();
    
    if (userAnswerData) {
      if (userAnswerData.answer) {
        userAnswerIds.add(userAnswerData.answer.id);
      }
      if (userAnswerData.answers) {
        userAnswerData.answers.forEach((a: Answer) => userAnswerIds.add(a.id));
      }
    }
    
    // Add E2E answer IDs
    e2eAnswers.forEach(a => userAnswerIds.add(a.id));
    
    // Merge server responses with E2E answers (avoid duplicates)
    const serverResponses = responses || [];
    const serverIds = new Set(serverResponses.map(r => r.id));
    const e2eToAdd = e2eAnswers.filter(a => !serverIds.has(a.id));
    
    // Convert E2E answers to response format
    const e2eAsResponses = e2eToAdd.map(a => ({
      ...a,
      created_at: new Date(a.created_at).getTime(),
      user_fid: userFid,
      is_e2e: true,
      // Add missing required Answer fields
      suggested_answer_type_id: a.answer_type_id,
      edited: false,
    })) as unknown as (Answer | AnswerWFname)[];
    
    const allResponses = [...serverResponses, ...e2eAsResponses];
    
    return allResponses.sort((a, b) => {
      const aIsUser = userAnswerIds.has(a.id) || ('is_own_anon' in a && a.is_own_anon);
      const bIsUser = userAnswerIds.has(b.id) || ('is_own_anon' in b && b.is_own_anon);
      
      if (aIsUser && !bIsUser) return -1;
      if (!aIsUser && bIsUser) return 1;
      
      const aTime = typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at).getTime();
      const bTime = typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at).getTime();
      return bTime - aTime;
    });
  }, [responses, userAnswerData, e2eAnswers, userFid]);

  // Filter Farcaster replies to remove duplicates
  const filteredFarcasterReplies = useMemo(() => {
    if (!farcasterReplies || farcasterReplies.length === 0) return [];
    
    const qbaseAuthorFids = new Set<number>();
    const qbaseCastHashes = new Set<string>();
    
    responses.forEach((answer) => {
      const userFid = 'user_fid' in answer ? answer.user_fid as number : undefined;
      if (userFid) {
        qbaseAuthorFids.add(userFid);
      }
      if ('casthash' in answer && answer.casthash) {
        qbaseCastHashes.add(answer.casthash as string);
      }
    });
    
    return farcasterReplies.filter((reply) => {
      if (qbaseCastHashes.has(reply.hash)) return false;
      if (qbaseAuthorFids.has(reply.author.fid)) return false;
      return true;
    });
  }, [farcasterReplies, responses]);

  const handleLikeError = (error: string) => {
    showToast(error, 'error');
  };

  const handleRecastError = (error: string) => {
    showToast(error, 'error');
  };

  const isAnswerValid = () => {
    if (answerValue === null || answerValue === undefined) return false;
    if (typeof answerValue === 'string') return answerValue.trim().length > 0;
    if (Array.isArray(answerValue)) return answerValue.every(v => v && v.toString().trim().length > 0);
    return true;
  };

  const handleVisibilityChange = async (newVisibility: Audiences) => {
    setVisibility(newVisibility);
    setIsDropdownOpen(false);
    
    try {
      await updateDefaultAudience(newVisibility);
    } catch (error) {
      console.error('Failed to save visibility preference:', error);
    }
  };

  const handleSaveAnswer = async () => {
    if (!isAnswerValid() || !user || !question) return;

    const needsUserSigner = visibility === 'Public';
    if (needsUserSigner && !hasSigner) {
      setShowSignerModal(true);
      return;
    }

    // E2E encryption for Private and Allowlist answers requires wallet connection
    if ((visibility === 'Private' || visibility === 'Allowlist') && needsWalletConnection) {
      setShowWalletModal(true);
      return;
    }

    setIsSaving(true);

    try {
      let answerTypeId: number = AnswerTypeId.TEXT;
      let displayValue: string;
      let answerData: AnswerData | undefined;

      if (question.type === 'mc' && answerValue !== null) {
        answerTypeId = AnswerTypeId.MC;
        displayValue = String(answerValue);
        const index = question.a_options?.indexOf(displayValue) ?? -1;
        answerData = { index };
      } else if (question.type === 'checkbox') {
        answerTypeId = AnswerTypeId.CHECKBOX;
        const checkboxValue = answerValue as CheckboxAnswerValue;
        displayValue = checkboxValue?.text || '';
        answerData = { indices: checkboxValue?.indices };
      } else if (question.type === 'scale' && typeof answerValue === 'number') {
        answerTypeId = AnswerTypeId.SCALE;
        const scaleConfig = question.scale_config || { min: 1, max: 5 };
        displayValue = getScaleLabel(answerValue, scaleConfig);
        answerData = { index: answerValue };
      } else {
        displayValue = String(answerValue || '');
      }

      const token = getAuthToken();

      // Use E2E encryption for new Private and Allowlist answers
      if ((visibility === 'Private' || visibility === 'Allowlist') && !isUpdating) {
        try {
          // E2E encrypted submission - server never sees plaintext
          await submitPrivateAnswer({
            q_id: question.id,
            value: displayValue,
            answer_type_id: answerTypeId,
            answer_data: answerData,
            primary_type: 'identity', // Default to identity type
            // TODO: Pass allowlist DIDs for Allowlist visibility
          });
          
          await refetchAnswers();
          setAnswerValue(null);
          const message = visibility === 'Allowlist' 
            ? 'Allowlist answer saved with end-to-end encryption!' 
            : 'Private answer saved with end-to-end encryption!';
          showToast(message, 'success');
          setIsSaving(false);
          return;
        } catch (e2eError) {
          console.error('[E2E] Failed to submit with E2E encryption:', e2eError);
          // Don't fall back to server storage for Private/Allowlist - it defeats the privacy purpose
          const errorMessage = e2eError instanceof Error ? e2eError.message : 'Unknown error';
          showToast(`Failed to save private answer: ${errorMessage}`, 'error');
          setIsSaving(false);
          return;
        }
      }

      if (isUpdating && existingAnswerId) {
        const updatePayload = {
          value: displayValue,
          answer_type_id: answerTypeId,
          audience: visibility,
          ...(answerData && { answer_data: answerData }),
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

        await refetchAnswers();
        showToast('Answer updated successfully!', 'success');
      } else {
        const answerPayload = {
          q_id: question.id,
          value: displayValue,
          answer_type_id: answerTypeId,
          audience: visibility,
          ...(answerData && { answer_data: answerData }),
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

        // Cast to Farcaster
        if (visibility === 'Public' && activeSigner) {
          try {
            const castText = displayValue;
            const includeEmbed = settings?.includeEmbedInAnswerCasts ?? false;
            
            const castPayload = question.casthash
              ? {
                  signerUuid: activeSigner.signer_uuid,
                  text: castText,
                  ...(includeEmbed && { embeds: [{ url: `${window.location.origin}/question/${question.id}` }] }),
                  parent: question.casthash,
                  parentAuthorFid: question.coiner_fid,
                  entityType: 'answer',
                  entityId: result.answerId,
                }
              : {
                  signerUuid: activeSigner.signer_uuid,
                  text: castText,
                  ...(includeEmbed && { embeds: [{ url: `${window.location.origin}/question/${question.id}` }] }),
                  parentUrl: `${window.location.origin}/question/${question.id}`,
                  entityType: 'answer',
                  entityId: result.answerId,
                };
            
            await fetch('/api/farcaster/cast', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token && { 'Authorization': `Bearer ${token}` }),
              },
              body: JSON.stringify(castPayload),
            });
          } catch (castError) {
            console.error('[Public Answer Cast] Exception:', castError);
          }
        } else if (visibility === 'Anon') {
          try {
            const castText = displayValue;
            const includeEmbed = settings?.includeEmbedInAnswerCasts ?? false;
            
            const castPayload = question.casthash
              ? {
                  useAnonBot: true,
                  text: castText,
                  ...(includeEmbed && { embeds: [{ url: `${window.location.origin}/question/${question.id}` }] }),
                  parent: question.casthash,
                  parentAuthorFid: question.coiner_fid,
                  entityType: 'answer',
                  entityId: result.answerId,
                }
              : {
                  useAnonBot: true,
                  text: castText,
                  ...(includeEmbed && { embeds: [{ url: `${window.location.origin}/question/${question.id}` }] }),
                  parentUrl: `${window.location.origin}/question/${question.id}`,
                  entityType: 'answer',
                  entityId: result.answerId,
                };
            
            await fetch('/api/farcaster/cast', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token && { 'Authorization': `Bearer ${token}` }),
              },
              body: JSON.stringify(castPayload),
            });
          } catch (castError) {
            console.error('[Anon Answer Cast] Exception:', castError);
          }
        }

        await refetchAnswers();

        if (!isUpdating) {
          setAnswerValue(null);
        }
        
        showToast('Answer saved successfully!', 'success');
      }
    } catch (error) {
      console.error('Error saving answer:', error);
      alert(error instanceof Error ? error.message : 'Failed to save answer');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="question-slide">
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

      <div className="question-slide-content">
        <div className="question-text-container">
          <button 
            className="analytics-icon-btn"
            onClick={() => setShowAnalyticsModal(true)}
            title="View analytics"
          >
            <ChartColumn size={18} />
          </button>
          <h1 className="qp-question-text" style={{ whiteSpace: 'pre-wrap' }}>{displayStem}</h1>
          
          {showCastRetry && onRetryCast && (
            <button 
              className="retry-cast-btn"
              onClick={onRetryCast}
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
                <span>{
                  (answersLoading || repliesLoading)
                    ? (question.pub_answers || 0)
                    : Math.max(sortedResponses.length, farcasterRepliesCount)
                }</span>
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
              {question.casthash ? (
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
              ) : isCastPending ? (
                <span className="icon-btn cast-pending-spinner" title="Posting to Farcaster...">
                  <LoadingAnimation variant="spinner" size="sm" />
                </span>
              ) : null}
              <Share size={18} className="icon-btn" />
            </div>
          </div>
        </div>

        {/* Answers List */}
        <div className="qp-answers-container">
          <div className="response-list">
            {/* Show spinner only when both are loading */}
            {answersLoading && repliesLoading && (
              <div className="responses-loading">
                <LoadingAnimation variant="spinner" size="md" />
              </div>
            )}
            
            {/* Qbase answers - shown first, animate in if replies loaded first */}
            {!answersLoading && sortedResponses.length > 0 && sortedResponses.map(response => {
              const answerText = typeof response.value === 'string' 
                ? response.value 
                : JSON.stringify(response.value);
              
              const isOwnAnswer = userAnswerData?.answer?.id === response.id ||
                userAnswerData?.answers?.some((a: Answer) => a.id === response.id) ||
                ('is_own_anon' in response && response.is_own_anon);
              const isOwnAnon = 'is_own_anon' in response && response.is_own_anon;
              
              const authorName = ('user_fname' in response && response.user_fname) 
                ? (response.user_fname as string)
                : '4n0n';
              
              const authorFid = 'user_fid' in response ? (response.user_fid as number) : undefined;
              const avatarUrl = 'user_pfp' in response ? (response.user_pfp as string) : undefined;
              const castHash = 'casthash' in response ? (response.casthash as string) : undefined;
              const likeCount = 'like_count' in response ? (response.like_count as number) : 0;
              const userHasLiked = 'user_has_liked' in response ? (response.user_has_liked as boolean) : false;
              
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
                  className="answer-slide-in"
                  castHash={castHash}
                  likeCount={likeCount}
                  userHasLiked={userHasLiked}
                />
              );
            })}
            
            {/* See more link for recurring questions */}
            {userAnswerData && 
             (userAnswerData.primary_type === 'recurring' || userAnswerData.primary_type === 'prospective') && 
             userAnswerData.count !== undefined && userAnswerData.count > 1 && (
              <div className="see-more-answers">
                <Link to={`/my-answers?q_id=${question.id}`}>
                  See {userAnswerData.count - 1} more of your answers
                </Link>
              </div>
            )}
            
            {/* Farcaster Replies - shown after qbase answers */}
            {!repliesLoading && filteredFarcasterReplies.map((reply: FarcasterReply) => (
              <CompactAnswerCard
                key={`fc-${reply.hash}`}
                id={reply.hash}
                answerText={reply.text}
                authorName={reply.author.username}
                authorFid={reply.author.fid}
                avatarUrl={reply.author.pfp_url}
                isOwnAnswer={reply.author.fid === user?.fid}
                isAnonymous={false}
                isFarcasterReply={true}
                createdAt={new Date(reply.timestamp).getTime()}
                questionText={question.stem}
                onClick={() => {
                  window.open(
                    `https://warpcast.com/${reply.author.username}/${reply.hash.substring(0, 10)}`,
                    '_blank'
                  );
                }}
              />
            ))}
            
            {/* Show "No responses" only when both have finished loading and both are empty */}
            {!answersLoading && !repliesLoading && 
             sortedResponses.length === 0 && filteredFarcasterReplies.length === 0 && (
              <div className="no-responses">No responses yet. Be the first to answer!</div>
            )}
          </div>
        </div>
      </div>

      {/* Floating Action Button - rendered via portal to escape transform containment */}
      {isActive && createPortal(
        <button
          className="answer-fab"
          onClick={() => setShowAnswerModal(true)}
          title="Add your answer"
        >
          🗣️
        </button>,
        document.body
      )}

      {/* Answer Modal - rendered via portal */}
      {showAnswerModal && createPortal(
        <div 
          className="answer-modal-overlay" 
          onClick={() => setShowAnswerModal(false)}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
        >
          <div 
            className="answer-modal" 
            onClick={e => e.stopPropagation()}
            onTouchStart={e => e.stopPropagation()}
            onTouchMove={e => e.stopPropagation()}
            onTouchEnd={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
          >
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
              {/* Character count for text answers - only show when approaching limit (90%+) */}
              {question.type === 'text' && typeof answerValue === 'string' && answerValue.length > MAX_A_LENGTH * 0.9 && (
                <div 
                  className="answer-char-count"
                  style={{ 
                    textAlign: 'right', 
                    fontSize: '12px', 
                    marginTop: '4px',
                    color: answerValue.length > MAX_A_LENGTH ? '#ef4444' : '#f59e0b'
                  }}
                >
                  {answerValue.length.toLocaleString()}/{MAX_A_LENGTH.toLocaleString()}
                  {answerValue.length > MAX_A_LENGTH && ' (exceeds limit)'}
                </div>
              )}
            </div>
            
            <div className="answer-modal-footer">
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
              
              <button
                className={`save-answer-btn ${isAnswerValid() ? 'active' : ''}`}
                disabled={!isAnswerValid() || isSaving}
                onClick={async () => {
                  await handleSaveAnswer();
                  if (!isSaving) setShowAnswerModal(false);
                }}
              >
                {isSaving ? 'Saving...' : isUpdating ? 'Update' : (visibility === 'Public' || visibility === 'Anon') ? 'Cast' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
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

      <WalletConnectModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnected={() => {
          setShowWalletModal(false);
          // Retry save after wallet connection
          handleSaveAnswer();
        }}
      />

      <QuestionAnalyticsModal
        isOpen={showAnalyticsModal}
        onClose={() => setShowAnalyticsModal(false)}
        question={question}
        answers={sortedResponses}
        farcasterReplies={filteredFarcasterReplies}
      />
    </div>
  );
};

export default QuestionSlide;

