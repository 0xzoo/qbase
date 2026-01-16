/**
 * LikeButton Component
 * 
 * Reusable like button that handles likes with optimistic UI updates.
 * Supports two modes:
 * 1. Answer likes (answerId) - Uses qbase internal likes, syncs to Farcaster if cast exists
 * 2. Farcaster likes (castHash only) - Direct Farcaster likes for questions
 * 
 * Shows SignerSetupModal if user doesn't have a signer.
 * 
 * Usage:
 * // For answers (qbase-internal + optional Farcaster sync)
 * <LikeButton 
 *   answerId="uuid-123"
 *   castHash="0x..." // optional, for Farcaster sync
 *   initialLiked={false}
 *   initialCount={10}
 * />
 * 
 * // For questions (Farcaster-only)
 * <LikeButton 
 *   castHash="0x..." 
 *   initialLiked={false}
 *   initialCount={10}
 * />
 */

import React, { useState, useEffect } from 'react';
import { Heart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import './LikeButton.css';

interface LikeButtonProps {
  /** Answer ID for qbase-internal likes (takes precedence over castHash-only mode) */
  answerId?: string;
  /** The cast hash for Farcaster sync (required for questions, optional for answers) */
  castHash?: string;
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
}

export const LikeButton: React.FC<LikeButtonProps> = ({
  answerId,
  castHash,
  initialLiked = false,
  initialCount = 0,
  showCount = true,
  size = 18,
  className = '',
  onLikeChange,
  onError,
}) => {
  const { hasSigner, activeSigner, isAuthenticated, getAuthToken } = useAuth();
  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(initialCount);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  // Update state when props change (e.g., on page reload or question change)
  useEffect(() => {
    setLiked(initialLiked);
    setLikeCount(initialCount);
  }, [initialLiked, initialCount]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent parent click events

    if (!isAuthenticated) {
      onError?.('Please sign in to like content');
      return;
    }

    // For answer likes, we don't require a signer (qbase-internal)
    // For question/cast likes, we do require a signer
    if (!answerId && !hasSigner) {
      setShowSignerModal(true);
      return;
    }

    // For answer likes, need answerId; for cast likes, need castHash
    if (!answerId && !castHash) {
      onError?.('This content cannot be liked yet');
      return;
    }

    // Optimistic UI update with animation
    const wasLiked = liked;
    const previousCount = likeCount;
    setLiked(!liked);
    setLikeCount(prev => wasLiked ? prev - 1 : prev + 1);
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 300);

    try {
      const token = getAuthToken();
      
      // Determine which API to call
      if (answerId) {
        // Answer like - uses qbase internal API (with optional Farcaster sync)
        const response = await fetch(`/api/answers/${answerId}/like`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
          },
          body: JSON.stringify({
            action: wasLiked ? 'unlike' : 'like',
            // Pass signer for optional Farcaster sync
            signerUuid: activeSigner?.signer_uuid,
          }),
        });

        if (response.ok) {
          const newCount = wasLiked ? previousCount - 1 : previousCount + 1;
          onLikeChange?.(!wasLiked, newCount);
        } else {
          // Rollback on failure
          setLiked(wasLiked);
          setLikeCount(previousCount);
          const errorData = await response.json().catch(() => ({}));
          console.error('Failed to like answer:', errorData);
          onError?.(errorData.error || 'Failed to like answer');
        }
      } else {
        // Farcaster-only like (for questions)
        const response = await fetch('/api/farcaster/like', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
          },
          body: JSON.stringify({
            signerUuid: activeSigner?.signer_uuid,
            castHash,
            action: wasLiked ? 'unlike' : 'like',
          }),
        });

        if (response.ok) {
          const newCount = wasLiked ? previousCount - 1 : previousCount + 1;
          onLikeChange?.(!wasLiked, newCount);
        } else {
          // Rollback on failure
          setLiked(wasLiked);
          setLikeCount(previousCount);
          console.error('Failed to like content');
          onError?.('Failed to like content');
        }
      }
    } catch (error) {
      // Rollback on error
      setLiked(wasLiked);
      setLikeCount(previousCount);
      console.error('Error liking content:', error);
      onError?.('Failed to like content');
    }
  };

  return (
    <>
      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="like this content"
      />

      <div
        className={`like-button-container ${className} ${isAnimating ? 'like-animating' : ''}`}
        onClick={handleLike}
        title={liked ? 'Unlike' : 'Like'}
        style={{ cursor: 'pointer' }}
      >
        <Heart
          size={size}
          fill={liked ? 'currentColor' : 'none'}
        />
        {showCount && <span className="like-count">{likeCount}</span>}
      </div>
    </>
  );
};

export default LikeButton;

