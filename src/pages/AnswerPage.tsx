import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MessageCircle, Heart, Repeat2, MoreVertical, Trash2, Globe, Lock, EyeOff, X } from 'lucide-react';
import Header from '../components/Header';
import { useAnswer } from '../hooks/useAnswers';
import { useQuestion } from '../hooks/useQuestions';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../hooks/useToast';
import CompactAnswerCard from '../components/CompactAnswerCard';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences } from '../lib/types';
import './AnswerPage.css';

const AnswerPage: React.FC = () => {
  const { answerId } = useParams<{ answerId: string }>();
  const { user, getAuthToken } = useAuth();
  const { showToast } = useToast();

  const { answer, loading: answerLoading, refetch: refetchAnswer } = useAnswer(answerId);
  const { question, loading: questionLoading } = useQuestion(answer?.q_id);

  // State for interactive elements
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isEditingAudience, setIsEditingAudience] = useState(false);
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

  // Get the answer's casthash for fetching Farcaster replies
  const answerCastHash = answer && 'casthash' in answer ? (answer as { casthash: string }).casthash : null;

  // Fetch Farcaster replies if the answer has a casthash
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    answerCastHash,
    user?.fid
  );

  // Use engagement data from Farcaster
  const displayLikes = farcasterEngagement?.likes_count ?? 0;
  const displayRecasts = farcasterEngagement?.recasts_count ?? 0;
  const displayReplies = farcasterEngagement?.replies_count ?? farcasterReplies.length;

  // Format answer value and date
  const answerText = answer
    ? (typeof answer.value === 'string' ? answer.value : JSON.stringify(answer.value))
    : null;
  const date = answer
    ? new Date(answer.created_at).toLocaleDateString()
    : null;

  // Default avatar for anonymous users or fallback
  const defaultAvatarUrl = isAnonymous
    ? `https://api.dicebear.com/7.x/shapes/svg?seed=anon`
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
    // UI Only for now as requested
    if (confirm('Are you sure you want to delete this answer?')) {
      console.log('Delete requested for answer:', answerId);
      showToast('Delete functionality coming soon', 'info');
      setIsMenuOpen(false);
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
                      <span className="ap-audience-badge" title={`Audience: ${answer.audience}`}>
                        {audienceIcon(answer.audience)}
                        {answer.audience}
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
                      <span className="ap-audience-badge" title={`Audience: ${answer.audience}`}>
                        {audienceIcon(answer.audience)}
                        {answer.audience}
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
                  <Heart size={18} />
                  <span>{displayLikes}</span>
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
                    href={`https://warpcast.com/${authorName}/${answerCastHash.substring(0, 10)}`}
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
                              <Lock size={16} /> Private
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
                            `https://warpcast.com/${reply.author.username}/${reply.hash.substring(0, 10)}`,
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
