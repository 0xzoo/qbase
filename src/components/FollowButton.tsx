/**
 * FollowButton Component
 * 
 * Reusable follow button for Farcaster users with optimistic UI updates.
 * Shows SignerSetupModal if user doesn't have a signer.
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
import { SignerSetupModal } from './SignerSetupModal';
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
  const { hasSigner, activeSigner, isAuthenticated, getAuthToken, user } = useAuth();
  const [isFollowing, setIsFollowing] = useState(initialFollowing);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  // Update state when props change
  useEffect(() => {
    setIsFollowing(initialFollowing);
  }, [initialFollowing]);

  // Don't show button if viewing own profile
  if (user?.fid === targetFid) {
    return null;
  }

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAuthenticated) {
      onError?.('Please sign in to follow users');
      return;
    }

    if (!hasSigner) {
      setShowSignerModal(true);
      return;
    }

    if (isLoading) return;

    // Optimistic UI update
    const wasFollowing = isFollowing;
    setIsFollowing(!wasFollowing);
    setIsLoading(true);

    try {
      const token = getAuthToken();
      const response = await fetch('/api/farcaster/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({
          signerUuid: activeSigner?.signer_uuid,
          targetFid,
          action: wasFollowing ? 'unfollow' : 'follow',
        }),
      });

      if (response.ok) {
        onFollowChange?.(!wasFollowing);
      } else {
        // Rollback on failure
        setIsFollowing(wasFollowing);
        const error = await response.json().catch(() => ({}));
        console.error('Failed to follow/unfollow:', error);
        onError?.('Failed to update follow status');
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
    <>
      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="follow users"
      />

      <button
        className={`follow-button ${sizeClasses[size]} ${className} ${
          isFollowing ? 'following' : ''
        } ${isHovering && isFollowing ? 'unfollow-hover' : ''} ${
          isLoading ? 'loading' : ''
        }`}
        onClick={handleClick}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        disabled={isLoading}
      >
        {getButtonText()}
      </button>
    </>
  );
};

export default FollowButton;

