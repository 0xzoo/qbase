import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Repeat2, MoreVertical, Trash2, Globe, Lock, EyeOff, X } from 'lucide-react';
import Header from '../components/Header';
import { useAnswer, useUserAnswerHistory } from '../hooks/useAnswers';
import { useQuestion } from '../hooks/useQuestions';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../hooks/useToast';
import CompactAnswerCard from '../components/CompactAnswerCard';
import { LikeButton } from '../components/LikeButton';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences } from '../lib/types';
import './AnswerPage.css';

const AnswerPage: React.FC = () => {
  const { answerId } = useParams<{ answerId: string }>();
  const { user, getAuthToken } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const { answer, loading: answerLoading, refetch: refetchAnswer } = useAnswer(answerId);
  const { question, loading: questionLoading } = useQuestion(answer?.q_id);

  // State for interactive elements
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditingAudience, setIsEditingAudience] = useState(false);
  const [, setIsDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Fetch user's profile picture
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Extract user info from answer
  const authorFid = answer ? ('user_fid' in answer ? (answer as { user_fid: number }).user_fid : null) : null;
  const authorName = answer
    ? (('user_fname' in answer && (answer as { user_fname: string }).user_fname)
      ? (answer as { user_fname: string }).user_fname
      : '4n0n')
    : null;
  const isAnonymous = !authorFid || authorName === 'Anonymous' || authorName === '4n0n';
  const isOwnAnswer = user?.fid && authorFid === user.fid;

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setIsEditingAudience(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch avatar if we have a FID and it's not anonymous
  useEffect(() => {
    if (!authorFid || isAnonymous) {
      setAvatarUrl(null);
      return;
    }

    const fetchAvatar = async () => {
      try {
        const response = await fetch(`/api/user/${authorFid}/avatar`);
        if (response.ok) {
          const data = await response.json();
          if (data.avatarUrl) {
            setAvatarUrl(data.avatarUrl);
          }
        }
      } catch (error) {
        console.error('Failed to fetch avatar:', error);
      }
    };

    fetchAvatar();
  }, [authorFid, isAnonymous]);

  // Past answers by this same author for the same question (Public only, reverse chron).
  // Skipped for anon answers: anon authors don't expose a real fid.
  const { answers: userHistory } = useUserAnswerHistory(
    answer && !isAnonymous ? answer.q_id : undefined,
    !isAnonymous && authorFid ? authorFid : undefined
  );
  const pastAnswers = userHistory.filter(a => a.id !== answerId);

  // Get the answer's casthash for fetching Farcaster replies
  const answerCastHash = answer && 'casthash' in answer ? (answer as { casthash: string }).casthash : null;

  // Fetch Farcaster replies if the answer has a casthash
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    answerCastHash,
    user?.fid
  );

  // Use engagement data - prefer qbase like_count, fall back to Farcaster
  const qbaseLikeCount = answer && 'like_count' in answer ? (answer as { like_count: number }).like_count : 0;
  const qbaseUserHasLiked = answer && 'user_has_liked' in answer ? (answer as { user_has_liked: boolean }).user_has_liked : false;
  const displayLikes = qbaseLikeCount || (farcasterEngagement?.likes_count ?? 0);
  const displayRecasts = farcasterEngagement?.recasts_count ?? 0;

  // Format answer value and date (value is now always plain display text)
  const answerText = answer?.value ?? null;
  const date = answer
    ? new Date(answer.created_at).toLocaleDateString()
    : null;

  // Default avatar for anonymous users or fallback
  const defaultAvatarUrl = isAnonymous
    ? `/4n0n.png`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${authorFid || 'default'}`;
  const finalAvatarUrl = avatarUrl || defaultAvatarUrl;

  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(!isMenuOpen);
    setIsEditingAudience(false);
  };

  const handleChangeAudience = async (newAudience: Audiences) => {
    if (!answer || !user) return;

    try {
      const token = getAuthToken();
      // Optimistic update logic could go here

      const updatePayload = {
        value: answerText, // Keep same value
        answer_type_id: answer.answer_type_id,
        audience: newAudience,
        // Preserve other fields if needed
      };

      const response = await fetch(`/api/answers/${answer.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        throw new Error('Failed to update audience');
      }

      showToast(`Audience updated to ${newAudience}`, 'success');
      refetchAnswer();
      setIsMenuOpen(false);
      setIsEditingAudience(false);
    } catch (error) {
      console.error('Error updating audience:', error);
      showToast('Failed to update audience', 'error');
    }
  };

  const handleDeleteAnswer = async () => {
    if (confirm('Are you sure you want to delete this answer?')) {
      try {
        setIsDeleting(true);
        const token = getAuthToken();
        const response = await fetch(`/api/answers/${answerId}`, {
          method: 'DELETE',
          headers: {
            ...(token && { 'Authorization': `Bearer ${token}` }),
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Failed to delete answer');
        }

        showToast('Answer deleted', 'success');
        navigate(-1);
      } catch (error) {
        console.error('Error deleting answer:', error);
        showToast(error instanceof Error ? error.message : 'Failed to delete answer', 'error');
      } finally {
        setIsDeleting(false);
        setIsMenuOpen(false);
      }
    }
  };

  if (answerLoading || questionLoading) {
    return (
      <>
        <Header showBack />
        <div className="loading-spinner">Loading...</div>
      </>
    );
  }

  if (!answer || !answerText) {
    return (
      <>
        <Header showBack />
        <div className="answer-not-found">Answer not found</div>
      </>
    );
  }

  const audienceIcon = (audience: string) => {
    switch (audience) {
      case 'Public': return <Globe size={14} />;
      case 'Private': return <Lock size={14} />;
      case 'Anon': return <EyeOff size={14} />;
      default: return <Globe size={14} />;
    }
  };

  const audienceLabel = (audience: string) => (audience === 'Private' ? 'Secret' : audience);

  return (
    <>
      <Header showBack />
      <div className="answer-page mobile-layout-container">
        <div className="answer-page-content">

          {/* Main Answer Card */}
          <div className="ap-main-card">

            {/* Question Link (Smaller above) */}
            <div className="ap-question-context">
              <Link to={`/question/${answer.q_id}`} className="ap-context-link">
                <p className="ap-context-text">{question?.stem || 'Loading question...'}</p>
              </Link>
            </div>

            {/* Answer Text - The Main Hero */}
            <h1 className="ap-answer-hero-text">{answerText}</h1>
          </div>

          {/* Footer with Author and Menu */}
          <div className="ap-card-footer">
            {/* Author Info */}
            <div className="ap-author-container">
              {isAnonymous ? (
                <div className="ap-author">
                  <div className="ap-author-avatar">
                    <img src={finalAvatarUrl} alt="Anonymous" />
                  </div>
                  <div className="ap-author-meta">
                    <span className="ap-author-name anon">4n0n</span>
                    <div className="ap-meta-row">
                      <span className="ap-answer-date">{date}</span>
                      <span className="ap-dot">•</span>
                      <span className="ap-audience-badge" title={`Audience: ${audienceLabel(answer.audience)}`}>
                        {audienceIcon(answer.audience)}
                        {audienceLabel(answer.audience)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <Link to={`/ask/${authorName}`} className="ap-author">
                  <div className="ap-author-avatar">
                    <img src={finalAvatarUrl} alt={`${authorName}'s avatar`} />
                  </div>
                  <div className="ap-author-meta">
                    <span className="ap-author-name">{authorName}</span>
                    <div className="ap-meta-row">
                      <span className="ap-answer-date">{date}</span>
                      <span className="ap-dot">•</span>
                      <span className="ap-audience-badge" title={`Audience: ${audienceLabel(answer.audience)}`}>
                        {audienceIcon(answer.audience)}
                        {audienceLabel(answer.audience)}
                      </span>
                    </div>
                  </div>
                </Link>
              )}
            </div>              

            {/* Engagement Stats (if answer was cast to Farcaster) */}

            <div className="ap-engagement">
              <div className='ap-engagement-left'>
                <div className="ap-engagement-item">
                  <LikeButton
                    answerId={answer.id}
                    initialLiked={qbaseUserHasLiked}
                    initialCount={displayLikes}
                    size={18}
                    className="ap-like-button"
                  />
                </div>
                {answerCastHash && (
                  <div className="ap-engagement-item">
                    <Repeat2 size={18} />
                    <span>{displayRecasts}</span>
                  </div>
                )}
              </div>
              <div className='ap-engagement-right'>
                {answerCastHash && (
                  <a
                    href={`https://farcaster.xyz/${authorName}/${answerCastHash.substring(0, 10)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ap-farcaster-link"
                    title="View on Farcaster"
                  >
                    <span className="fc-label">View on Farcaster</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="14" viewBox="0 0 22 20" fill="none">
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
                {/* Action Menu (Kebab) - Only for own answers */}
                {isOwnAnswer && (
                  <div className="ap-actions-container">
                    <button
                      ref={buttonRef}
                      className={`ap-kebab-btn ${isMenuOpen ? 'active' : ''}`}
                      onClick={toggleMenu}
                    >
                      <MoreVertical size={20} />
                    </button>

                    {isMenuOpen && (
                      <div className="ap-dropdown-menu" ref={menuRef}>
                        {!isEditingAudience ? (
                          <>
                            <button className="ap-menu-item" onClick={() => setIsEditingAudience(true)}>
                              <Globe size={16} />
                              <span>Change Audience</span>
                            </button>
                            <button className="ap-menu-item delete" onClick={handleDeleteAnswer}>
                              <Trash2 size={16} />
                              <span>Delete Answer</span>
                            </button>
                          </>
                        ) : (
                          <div className="ap-audience-selector">
                            <div className="ap-menu-header">
                              <span>Select Audience</span>
                              <button onClick={() => setIsEditingAudience(false)}><X size={14} /></button>
                            </div>
                            <button className={`ap-menu-item ${answer.audience === 'Public' ? 'selected' : ''}`} onClick={() => handleChangeAudience('Public')}>
                              <Globe size={16} /> Public
                            </button>
                            <button className={`ap-menu-item ${answer.audience === 'Anon' ? 'selected' : ''}`} onClick={() => handleChangeAudience('Anon')}>
                              <EyeOff size={16} /> Anon
                            </button>
                            <button className={`ap-menu-item ${answer.audience === 'Private' ? 'selected' : ''}`} onClick={() => handleChangeAudience('Private')}>
                              <Lock size={16} /> Secret
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* Past answers from the same author for this question */}
          {pastAnswers.length > 0 && (
            <div className="ap-replies-section">
              <div className="ap-replies-header">
                <span className="ap-replies-divider-line"></span>
                <span className="ap-replies-title">
                  {isOwnAnswer ? 'Your past answers' : `More from ${authorName}`}
                </span>
                <span className="ap-replies-divider-line"></span>
              </div>
              <div className="ap-replies-list">
                {pastAnswers.map((past) => {
                  const pastFid = 'user_fid' in past ? (past as { user_fid: number }).user_fid : undefined;
                  const pastName = ('user_fname' in past && (past as { user_fname: string }).user_fname)
                    ? (past as { user_fname: string }).user_fname
                    : (authorName ?? '');
                  const pastCastHash = 'casthash' in past ? (past as { casthash: string }).casthash : undefined;
                  const pastLikeCount = 'like_count' in past ? (past as { like_count: number }).like_count : 0;
                  const pastUserHasLiked = 'user_has_liked' in past ? (past as { user_has_liked: boolean }).user_has_liked : false;
                  return (
                    <CompactAnswerCard
                      key={past.id}
                      id={past.id}
                      answerText={past.value}
                      authorName={pastName}
                      authorFid={pastFid}
                      isOwnAnswer={!!user?.fid && pastFid === user.fid}
                      isAnonymous={false}
                      createdAt={past.created_at}
                      castHash={pastCastHash}
                      likeCount={pastLikeCount}
                      userHasLiked={pastUserHasLiked}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Farcaster Replies Section */}
          {answerCastHash && (
            <div className="ap-replies-section">
              {repliesLoading ? (
                <div className="ap-loading-replies">Loading replies...</div>
              ) : farcasterReplies.length > 0 ? (
                <>
                  <div className="ap-replies-header">
                    <span className="ap-replies-divider-line"></span>
                    <span className="ap-replies-title">Replies from Farcaster</span>
                    <span className="ap-replies-divider-line"></span>
                  </div>
                  <div className="ap-replies-list">
                    {farcasterReplies.map((reply: FarcasterReply) => (
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
                        onClick={() => {
                          window.open(
                            `https://farcaster.xyz/${reply.author.username}/${reply.hash.substring(0, 10)}`,
                            '_blank'
                          );
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AnswerPage;
