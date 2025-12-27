/**
 * LikeButton Component
 * 
 * Example of a like button that checks for signer before allowing the action.
 * Shows SignerSetupModal if user doesn't have a signer.
 * 
 * Usage:
 * <LikeButton castHash="0x..." />
 */

import React, { useState } from 'react';
import { Heart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import './LikeButton.css';

interface LikeButtonProps {
  /** The cast hash or content ID to like */
  castHash?: string;
  /** Whether this content is already liked */
  initialLiked?: boolean;
  /** Callback when like status changes */
  onLikeChange?: (liked: boolean) => void;
}

export const LikeButton: React.FC<LikeButtonProps> = ({
  castHash,
  initialLiked = false,
  onLikeChange,
}) => {
  const { hasSigner, activeSigner, isAuthenticated } = useAuth();
  const [liked, setLiked] = useState(initialLiked);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleLike = async () => {
    if (!isAuthenticated) {
      alert('Please sign in to like content');
      return;
    }

    // Check if user has a signer
    if (!hasSigner) {
      setShowSignerModal(true);
      return;
    }

    // User has signer, perform the like action
    setIsLoading(true);
    try {
      // Example API call - adjust based on your actual endpoint
      const response = await fetch('/api/farcaster/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerUuid: activeSigner?.signer_uuid,
          castHash,
          action: liked ? 'unlike' : 'like',
        }),
      });

      if (response.ok) {
        const newLiked = !liked;
        setLiked(newLiked);
        onLikeChange?.(newLiked);
      } else {
        console.error('Failed to like content');
      }
    } catch (error) {
      console.error('Error liking content:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="like this content"
      />

      <button
        className={`like-button ${liked ? 'liked' : ''} ${isLoading ? 'loading' : ''}`}
        onClick={handleLike}
        disabled={isLoading}
        title={liked ? 'Unlike' : 'Like'}
      >
        <Heart
          size={18}
          fill={liked ? 'currentColor' : 'none'}
          className={isLoading ? 'pulse' : ''}
        />
      </button>
    </>
  );
};

export default LikeButton;

