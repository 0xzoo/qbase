/**
 * FollowButton Component
 * 
 * Reusable follow button for qbase-native follow system.
 * Handles follow/unfollow actions via internal API.
 * 
 * Usage:
 * <FollowButton 
 *   targetFid={12345}
 *   initialFollowing={false}
 *   size="md"
 * />
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './FollowButton.css';

interface FollowButtonProps {
  /** The FID of the user to follow/unfollow */
  targetFid: number;
  /** Whether we're initially following this user */
  initialFollowing?: boolean;
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes */
  className?: string;
  /** Callback when follow status changes */
  onFollowChange?: (following: boolean) => void;
  /** Callback for errors */
  onError?: (error: string) => void;
}

export const FollowButton: React.FC<FollowButtonProps> = ({
  targetFid,
  initialFollowing = false,
  size = 'md',
  className = '',
  onFollowChange,
  onError,
}) => {
  const { isAuthenticated, accountId, fid: farcasterFid } = useAuth();
  const [isFollowing, setIsFollowing] = useState(initialFollowing);
  const [isLoading, setIsLoading] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [initialStateChecked, setInitialStateChecked] = useState(false);

  // If initialFollowing is not provided, check from API on mount
  useEffect(() => {
    const checkInitialState = async () => {
      if (initialFollowing !== undefined) {
        setIsFollowing(initialFollowing);
        setInitialStateChecked(true);
        return;
      }

      if (!isAuthenticated || !accountId) {
        setInitialStateChecked(true);
        return;
      }

      try {
        const response = await apiClient.get(`/api/follows/check?target=${targetFid}`);
        if (response.ok) {
          const data = await response.json();
          setIsFollowing(data.is_following);
        }
      } catch (error) {
        console.error('Error checking initial follow state:', error);
      } finally {
        setInitialStateChecked(true);
      }
    };

    checkInitialState();
  }, [targetFid, initialFollowing, isAuthenticated, accountId]);

  // Update state when props change
  useEffect(() => {
    if (initialFollowing !== undefined) {
      setIsFollowing(initialFollowing);
    }
  }, [initialFollowing]);

  // Don't show button if viewing own profile. targetFid is a Farcaster fid
  // (the only caller is the Neynar-backed ProfilePage).
  // TODO(account-root): follows are stored by person key; the server must map
  // `target` (a Farcaster fid) to its account, or this prop becomes an account id.
  if (farcasterFid != null && farcasterFid === targetFid) {
    return null;
  }

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAuthenticated) {
      onError?.('Please sign in to follow users');
      return;
    }

    if (isLoading || !initialStateChecked) return;

    // Optimistic UI update
    const wasFollowing = isFollowing;
    setIsFollowing(!wasFollowing);
    setIsLoading(true);

    try {
      const response = await apiClient.post('/api/follows', {
        target_fid: targetFid,
      });

      if (response.ok) {
        const data = await response.json();
        // Use server response if available, otherwise use optimistic update
        setIsFollowing(data.success !== false ? !wasFollowing : wasFollowing);
        onFollowChange?.(!wasFollowing);
      } else {
        // Rollback on failure
        setIsFollowing(wasFollowing);
        const error = await response.json().catch(() => ({}));
        console.error('Failed to update follow status:', error);
        onError?.(error.error || 'Failed to update follow status');
      }
    } catch (error) {
      // Rollback on error
      setIsFollowing(wasFollowing);
      console.error('Error following/unfollowing:', error);
      onError?.('Failed to update follow status');
    } finally {
      setIsLoading(false);
    }
  };

  const sizeClasses = {
    sm: 'follow-btn-sm',
    md: 'follow-btn-md',
    lg: 'follow-btn-lg',
  };

  const getButtonText = () => {
    if (isLoading) {
      return isFollowing ? 'Unfollowing...' : 'Following...';
    }
    if (isFollowing) {
      return isHovering ? 'Unfollow' : 'Following';
    }
    return 'Follow';
  };

  return (
    <button
      className={`follow-button ${sizeClasses[size]} ${className} ${
        isFollowing ? 'following' : ''
      } ${isHovering && isFollowing ? 'unfollow-hover' : ''} ${
        isLoading ? 'loading' : ''
      }`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      disabled={isLoading || !initialStateChecked}
    >
      {getButtonText()}
    </button>
  );
};

export default FollowButton;
