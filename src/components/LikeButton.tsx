/**
 * LikeButton Component
 * 
 * qbase-native like button for answers. Uses D1 answer_likes table.
 * No Farcaster dependency.
 * 
 * Usage:
 * <LikeButton 
 *   answerId="uuid-123"
 *   initialLiked={false}
 *   initialCount={10}
 * />
 */

import React, { useState, useEffect } from 'react';
import { Heart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './LikeButton.css';

interface LikeButtonProps {
  /** Answer ID for qbase likes */
  answerId?: string;
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
  initialLiked = false,
  initialCount = 0,
  showCount = true,
  size = 18,
  className = '',
  onLikeChange,
  onError,
}) => {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [liked, setLiked] = useState(initialLiked);
  const [likeCount, setLikeCount] = useState(initialCount);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    setLiked(initialLiked);
    setLikeCount(initialCount);
  }, [initialLiked, initialCount]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAuthenticated) {
      onError?.('Please sign in to like content');
      return;
    }

    if (!answerId) {
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

    try {
      const token = await getAuthToken();

      const response = await fetch(`/api/answers/${answerId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({
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
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to like answer:', errorData);
        onError?.(errorData.error || 'Failed to like answer');
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
  );
};

export default LikeButton;
