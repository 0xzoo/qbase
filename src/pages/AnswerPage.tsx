import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MessageCircle, Heart, Repeat2 } from 'lucide-react';
import Header from '../components/Header';
import { useAnswer } from '../hooks/useAnswers';
import { useQuestion } from '../hooks/useQuestions';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import { useAuth } from '../context/AuthContext';
import CompactAnswerCard from '../components/CompactAnswerCard';
import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import './AnswerPage.css';

const AnswerPage: React.FC = () => {
  const { answerId } = useParams<{ answerId: string }>();
  const { user } = useAuth();

  const { answer, loading: answerLoading } = useAnswer(answerId);
  const { question, loading: questionLoading } = useQuestion(answer?.q_id);
  
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

  return (
    <>
      <Header showBack />
      <div className="answer-page mobile-layout-container">
        <div className="answer-page-content">
          {/* Question Section */}
          <div className="ap-question-section">
            <Link to={`/question/${answer.q_id}`} className="ap-question-link">
              <h1 className="ap-question-text">{question?.stem || 'Loading question...'}</h1>
            </Link>
          </div>

          {/* Main Answer Card */}
          <div className="ap-answer-card">
            <div className="ap-answer-header">
              {/* Author Info with Profile Link */}
              {isAnonymous ? (
                <div className="ap-author">
                  <div className="ap-author-avatar">
                    <img src={finalAvatarUrl} alt="Anonymous" />
                  </div>
                  <span className="ap-author-name anon">4n0n</span>
                </div>
              ) : (
                <Link to={`/ask/${authorName}`} className="ap-author">
                  <div className="ap-author-avatar">
                    <img src={finalAvatarUrl} alt={`${authorName}'s avatar`} />
                  </div>
                  <span className="ap-author-name">@{authorName}</span>
                </Link>
              )}
              
              {/* Date */}
              {date && <span className="ap-answer-date">{date}</span>}
            </div>
            
            {/* Answer Text */}
            <p className="ap-answer-text">{answerText}</p>
            
            {/* Engagement Stats (if answer was cast to Farcaster) */}
            {answerCastHash && (
              <div className="ap-engagement">
                <div className="ap-engagement-item">
                  <MessageCircle size={16} />
                  <span>{displayReplies}</span>
                </div>
                <div className="ap-engagement-item">
                  <Heart size={16} />
                  <span>{displayLikes}</span>
                </div>
                <div className="ap-engagement-item">
                  <Repeat2 size={16} />
                  <span>{displayRecasts}</span>
                </div>
                <a 
                  href={`https://warpcast.com/${authorName}/${answerCastHash.substring(0, 10)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ap-farcaster-link"
                  title="View on Farcaster"
                >
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
              </div>
            )}
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
