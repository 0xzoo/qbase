import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { MessageCircle, MessageCircleDashed, Share, Eye, ChevronDown, RefreshCw, Plus, X } from 'lucide-react';
import QuestionRenderer from './QuestionRenderer';
import SignerSetupModal from './SignerSetupModal';
import Toast from './Toast';
import { LikeButton } from './LikeButton';
import { RecastButton } from './RecastButton';
import CompactAnswerCard from './CompactAnswerCard';
import { useAuth } from '../context/AuthContext';
import { useUserSettings } from '../hooks/useUserSettings';
import { useAnswers, useUserAnswerForQuestion } from '../hooks/useAnswers';
import { useToast } from '../hooks/useToast';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences, Answer, AnswerWFname, Query } from '../lib/types';
import './QuestionSlide.css';

interface QuestionSlideProps {
  question: Query;
  isActive: boolean;
  onRetryCast?: () => void;
  isRetryingCast?: boolean;
  showCastRetry?: boolean;
}

const QuestionSlide: React.FC<QuestionSlideProps> = ({
  question,
  isActive,
  onRetryCast,
  isRetryingCast = false,
  showCastRetry = false,
}) => {
  const { settings, updateDefaultAudience } = useUserSettings();
  const { user, hasSigner, activeSigner, getAuthToken } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  
  // State
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showAnswerModal, setShowAnswerModal] = useState(false);
  const [answerValue, setAnswerValue] = useState<unknown>(null);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [existingAnswerId, setExistingAnswerId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  
  // Optimistic update for answer counts
  const [optimisticPubDelta, setOptimisticPubDelta] = useState(0);
  const [optimisticPrivDelta, setOptimisticPrivDelta] = useState(0);

  // Lazy load data only when slide is active or nearby
  const { answers, loading: answersLoading, refetch: refetchAnswers } = useAnswers({ 
    queryId: isActive ? question.id : undefined 
  });
  
  const userFid = user?.fid;
  const { data: userAnswerData, loading: userAnswerLoading } = useUserAnswerForQuestion(
    isActive ? userFid : undefined, 
    isActive ? question.id : undefined
  );

  // Fetch Farcaster replies
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    isActive ? question?.casthash : undefined,
    user?.fid
  );

  const responses = answers as (Answer | AnswerWFname)[];

  // Display values
  const displayLikes = farcasterEngagement?.likes_count ?? question?.farcaster_likes ?? 0;
  const displayRecasts = farcasterEngagement?.recasts_count ?? question?.farcaster_recasts ?? 0;
  const freshFarcasterReplies = farcasterEngagement?.replies_count ?? 0;

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
    setOptimisticPubDelta(0);
    setOptimisticPrivDelta(0);
  }, [question.id]);

  // Pre-populate answer for identity questions
  useEffect(() => {
    if (!userAnswerData || userAnswerLoading) return;

    if (userAnswerData.primary_type === 'identity' && userAnswerData.answer) {
      const answer = userAnswerData.answer;
      const actualValue = typeof answer.value === 'string' ? answer.value : String(answer.value);
      
      if (question?.type === 'mc' && answer.q_index !== undefined) {
        setAnswerValue(answer.q_index);
      } else if (question?.type === 'scale') {
        setAnswerValue(parseInt(actualValue));
      } else {
        setAnswerValue(actualValue);
      }

      setVisibility(answer.audience as Audiences);
      setIsUpdating(true);
      setExistingAnswerId(answer.id);
    }
  }, [userAnswerData, userAnswerLoading, question]);

  // Sort answers with user's own at the top
  const sortedResponses = useMemo(() => {
    if (!responses) return [];
    
    const userAnswerIds = new Set<string>();
    
    if (userAnswerData) {
      if (userAnswerData.answer) {
        userAnswerIds.add(userAnswerData.answer.id);
      }
      if (userAnswerData.answers) {
        userAnswerData.answers.forEach((a: Answer) => userAnswerIds.add(a.id));
      }
    }
    
    return [...responses].sort((a, b) => {
      const aIsUser = userAnswerIds.has(a.id) || ('is_own_anon' in a && a.is_own_anon);
      const bIsUser = userAnswerIds.has(b.id) || ('is_own_anon' in b && b.is_own_anon);
      
      if (aIsUser && !bIsUser) return -1;
      if (!aIsUser && bIsUser) return 1;
      
      return b.created_at - a.created_at;
    });
  }, [responses, userAnswerData]);

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

    setIsSaving(true);

    try {
      let answerTypeId = 'text';
      let processedValue = answerValue;
      let qIndex: number | undefined;

      if (question.type === 'mc' && typeof answerValue === 'number') {
        answerTypeId = 'multiple_choice';
        qIndex = answerValue;
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
        processedValue = String(answerValue);
      }

      const token = getAuthToken();

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

        await refetchAnswers();
        showToast('Answer updated successfully!', 'success');
      } else {
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

        // Cast to Farcaster
        if (visibility === 'Public' && activeSigner) {
          try {
            const castText = `${question.stem}\n\nMy answer: ${processedValue}`;
            
            const castPayload = question.casthash
              ? {
                  signerUuid: activeSigner.signer_uuid,
                  text: castText,
                  embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                  parent: question.casthash,
                  parentAuthorFid: question.coiner_fid,
                  entityType: 'answer',
                  entityId: result.answerId,
                }
              : {
                  signerUuid: activeSigner.signer_uuid,
                  text: castText,
                  embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
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
            const castText = `${question.stem}\n\nAnswered anonymously via @qbase`;
            
            const castPayload = question.casthash
              ? {
                  useAnonBot: true,
                  text: castText,
                  embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
                  parent: question.casthash,
                  parentAuthorFid: question.coiner_fid,
                  entityType: 'answer',
                  entityId: result.answerId,
                }
              : {
                  useAnonBot: true,
                  text: castText,
                  embeds: [{ url: `${window.location.origin}/question/${question.id}` }],
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

        // Optimistic count update
        if (visibility === 'Public' || visibility === 'Anon') {
          setOptimisticPubDelta(prev => prev + 1);
        } else if (visibility === 'Private') {
          setOptimisticPrivDelta(prev => prev + 1);
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
                    ? (question.pub_answers || 0) + optimisticPubDelta
                    : sortedResponses.length + freshFarcasterReplies + optimisticPubDelta
                }</span>
              </div>
              <div className="icon-with-count" title="Private answers">
                <MessageCircleDashed size={18} />
                <span>{(question.priv_answers || 0) + optimisticPrivDelta}</span>
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
            
            {/* See more link for recurring questions */}
            {userAnswerData && 
             (userAnswerData.primary_type === 'recurring' || userAnswerData.primary_type === 'prospective') && 
             userAnswerData.count && userAnswerData.count > 1 && (
              <div className="see-more-answers">
                <Link to={`/my-answers?q_id=${question.id}`}>
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

      {/* Floating Action Button - rendered via portal to escape transform containment */}
      {isActive && createPortal(
        <button
          className="answer-fab"
          onClick={() => setShowAnswerModal(true)}
          title="Add your answer"
        >
          <Plus size={24} />
        </button>,
        document.body
      )}

      {/* Answer Modal - rendered via portal */}
      {showAnswerModal && createPortal(
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
    </div>
  );
};

export default QuestionSlide;

