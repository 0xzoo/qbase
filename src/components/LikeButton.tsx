/**
 * LikeButton Component
 *
 * Likes either an answer (D1 answer_likes table — no Farcaster dependency) or
 * a question (Farcaster reaction via the user's approved signer, mirrored into
 * farcaster_reactions for fast reads).
 *
 * Pass `answerId` OR `questionId`, not both.
 */

import React, { useState, useEffect } from 'react';
import { Heart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { FARCASTER_REQUIRED_MESSAGE, isFarcasterRequired, isFarcasterRequiredBody } from '../lib/farcasterRequired';
import './LikeButton.css';

interface LikeButtonProps {
  /** Answer ID — uses qbase D1 likes */
  answerId?: string;
  /** Question ID — uses Farcaster reactions, requires user signer */
  questionId?: string;
  /** Whether this content is already liked */
  initialLiked?: boolean;
  /** Initial like count */
  initialCount?: number;
  /** Whether to show the like count */
  showCount?: boolean;
  /** Icon size */
  size?: number;
  /** Additional CSS classes */
  className?: string;
  /** Callback when like status changes */
  onLikeChange?: (liked: boolean, newCount: number) => void;
  /** Callback for errors */
  onError?: (error: string) => void;
  /** Show the count only (e.g. a question's Farcaster likes to a viewer without Farcaster) */
  readOnly?: boolean;
}

/**
 * Walk the user through creating + approving a Neynar signer. Used when the
 * server returns 403 needsSigner from the question-like endpoint.
 */
async function bootstrapSignerInteractive(getAuthToken: () => string | null): Promise<boolean> {
  const proceed = window.confirm(
    'To like questions, connect your Farcaster account. This opens a new tab to approve a signer. Continue?'
  );
  if (!proceed) return false;

  const token = getAuthToken();
  if (!token) return false;

  const createRes = await fetch('/api/farcaster/signer/create', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!createRes.ok) {
    if (await isFarcasterRequired(createRes)) throw new Error(FARCASTER_REQUIRED_MESSAGE);
    throw new Error((await createRes.json().catch(() => ({}))).error || 'Failed to create signer');
  }
  const { approval_url, signer_uuid } = await createRes.json() as {
    approval_url: string; signer_uuid: string;
  };

  // Open approval in a new tab. The user approves in their Farcaster client,
  // then we poll until the server-side status flips to 'approved'.
  window.open(approval_url, '_blank', 'noopener');

  const start = Date.now();
  const TIMEOUT_MS = 120_000;
  const POLL_MS = 3_000;
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const statusRes = await fetch(
      `/api/farcaster/signer/status?signer_uuid=${encodeURIComponent(signer_uuid)}`
    );
    if (statusRes.ok) {
      const data = await statusRes.json() as { status: string };
      if (data.status === 'approved') return true;
      if (data.status === 'revoked') return false;
    }
  }
  return false;
}

export const LikeButton: React.FC<LikeButtonProps> = ({
  answerId,
  questionId,
  initialLiked = false,
  initialCount = 0,
  showCount = true,
  size = 18,
  className = '',
  onLikeChange,
  onError,
  readOnly = false,
}) => {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(initialCount);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isBootstrappingSigner, setIsBootstrappingSigner] = useState(false);

  useEffect(() => {
    setLiked(initialLiked);
    setLikeCount(initialCount);
  }, [initialLiked, initialCount]);

  // POSTs the like/unlike with current auth token. Returns the parsed response
  // so the caller can branch on needsSigner / other failure modes.
  const sendLikeRequest = async (wasLiked: boolean): Promise<Response> => {
    const token = getAuthToken();
    const path = questionId
      ? `/api/queries/${questionId}/like`
      : `/api/answers/${answerId}/like`;
    return fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: JSON.stringify({ action: wasLiked ? 'unlike' : 'like' }),
    });
  };

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAuthenticated) {
      onError?.('Please sign in to like content');
      return;
    }

    if (!answerId && !questionId) {
      onError?.('This content cannot be liked yet');
      return;
    }

    // Optimistic UI update
    const wasLiked = liked;
    const previousCount = likeCount;
    setLiked(!liked);
    setLikeCount(prev => wasLiked ? prev - 1 : prev + 1);
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 300);

    const rollback = () => {
      setLiked(wasLiked);
      setLikeCount(previousCount);
    };

    try {
      let response = await sendLikeRequest(wasLiked);

      // 403 needsSigner: walk the user through signer creation, then retry once.
      if (response.status === 403 && questionId) {
        const errorData = await response.clone().json().catch(() => ({}));
        if (errorData.needsSigner) {
          setIsBootstrappingSigner(true);
          try {
            const approved = await bootstrapSignerInteractive(getAuthToken);
            if (!approved) {
              rollback();
              onError?.('Signer not approved. Try liking again after approving.');
              return;
            }
            response = await sendLikeRequest(wasLiked);
          } finally {
            setIsBootstrappingSigner(false);
          }
        }
      }

      if (response.ok) {
        const newCount = wasLiked ? previousCount - 1 : previousCount + 1;
        onLikeChange?.(!wasLiked, newCount);
      } else {
        rollback();
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to like content:', errorData);
        onError?.(isFarcasterRequiredBody(response.status, errorData)
          ? FARCASTER_REQUIRED_MESSAGE
          : (errorData.error || 'Failed to like content'));
      }
    } catch (error: any) {
      rollback();
      console.error('Error liking content:', error);
      onError?.(error?.message || 'Failed to like content');
    }
  };

  if (readOnly) {
    return (
      <div className={`like-button-container ${className}`} title="Likes on Farcaster">
        <Heart size={size} fill="none" />
        {showCount && <span className="like-count">{likeCount}</span>}
      </div>
    );
  }

  return (
    <div
      className={`like-button-container ${className} ${isAnimating ? 'like-animating' : ''}`}
      onClick={isBootstrappingSigner ? undefined : handleLike}
      title={isBootstrappingSigner ? 'Waiting for signer approval...' : (liked ? 'Unlike' : 'Like')}
      style={{ cursor: isBootstrappingSigner ? 'wait' : 'pointer', opacity: isBootstrappingSigner ? 0.6 : 1 }}
    >
      <Heart
        size={size}
        fill={liked ? 'currentColor' : 'none'}
      />
      {showCount && <span className="like-count">{likeCount}</span>}
    </div>
  );
};

export default LikeButton;
