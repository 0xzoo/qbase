/**
 * RecastButton Component
 * 
 * Reusable recast button that handles Farcaster cast recasts with optimistic UI updates.
 * Shows SignerSetupModal if user doesn't have a signer.
 * 
 * Usage:
 * <RecastButton 
 *   castHash="0x..." 
 *   initialRecasted={false}
 *   initialCount={10}
 *   showCount={true}
 *   size={18}
 * />
 */

import React, { useState, useEffect } from 'react';
import { Repeat } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SignerSetupModal } from './SignerSetupModal';
import './RecastButton.css';

interface RecastButtonProps {
  /** The cast hash or content ID to recast */
  castHash?: string;
  /** Whether this content is already recasted */
  initialRecasted?: boolean;
  /** Initial recast count */
  initialCount?: number;
  /** Whether to show the recast count */
  showCount?: boolean;
  /** Icon size */
  size?: number;
  /** Additional CSS classes */
  className?: string;
  /** Callback when recast status changes */
  onRecastChange?: (recasted: boolean, newCount: number) => void;
  /** Callback for errors */
  onError?: (error: string) => void;
}

export const RecastButton: React.FC<RecastButtonProps> = ({
  castHash,
  initialRecasted = false,
  initialCount = 0,
  showCount = true,
  size = 18,
  className = '',
  onRecastChange,
  onError,
}) => {
  const { hasSigner, activeSigner, isAuthenticated, getAuthToken } = useAuth();
  const [recasted, setRecasted] = useState(initialRecasted);
  const [recastCount, setRecastCount] = useState(initialCount);
  const [showSignerModal, setShowSignerModal] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  // Update state when props change (e.g., on page reload or question change)
  useEffect(() => {
    setRecasted(initialRecasted);
    setRecastCount(initialCount);
  }, [initialRecasted, initialCount]);

  const handleRecast = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent parent click events

    if (!isAuthenticated) {
      onError?.('Please sign in to recast content');
      return;
    }

    if (!hasSigner) {
      setShowSignerModal(true);
      return;
    }

    if (!castHash) {
      onError?.('This content cannot be recasted yet');
      return;
    }

    // Optimistic UI update with animation
    const wasRecasted = recasted;
    const previousCount = recastCount;
    setRecasted(!recasted);
    setRecastCount(prev => wasRecasted ? prev - 1 : prev + 1);
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 500);

    try {
      const token = getAuthToken();
      const response = await fetch('/api/farcaster/recast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({
          signerUuid: activeSigner?.signer_uuid,
          castHash,
          action: wasRecasted ? 'unrecast' : 'recast',
        }),
      });

      if (response.ok) {
        const newCount = wasRecasted ? previousCount - 1 : previousCount + 1;
        onRecastChange?.(!wasRecasted, newCount);
      } else {
        // Rollback on failure
        setRecasted(wasRecasted);
        setRecastCount(previousCount);
        console.error('Failed to recast content');
        onError?.('Failed to recast content');
      }
    } catch (error) {
      // Rollback on error
      setRecasted(wasRecasted);
      setRecastCount(previousCount);
      console.error('Error recasting content:', error);
      onError?.('Failed to recast content');
    }
  };

  return (
    <>
      <SignerSetupModal
        isOpen={showSignerModal}
        onClose={() => setShowSignerModal(false)}
        action="recast this content"
      />

      <div
        className={`recast-button-container ${className} ${isAnimating ? 'recast-animating' : ''} ${recasted ? 'recasted' : ''}`}
        onClick={handleRecast}
        title={recasted ? 'Remove recast' : 'Recast'}
        style={{ cursor: 'pointer' }}
      >
        <Repeat
          size={size}
        />
        {showCount && <span className="recast-count">{recastCount}</span>}
      </div>
    </>
  );
};

export default RecastButton;

