/**
 * ShareButton Component
 * 
 * Generic share button that uses composeCast in miniapp mode
 * and clipboard/native share on web.
 */

import React, { useState } from 'react';
import { Share2 } from 'lucide-react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useAuth } from '../context/AuthContext';
import './ShareButton.css';

interface ShareButtonProps {
  /** URL to share */
  url: string;
  /** Pre-filled text for the share */
  text?: string;
  /** Icon size */
  size?: number;
  /** Additional CSS classes */
  className?: string;
  /** Callback after share */
  onShare?: () => void;
  /** Callback for errors */
  onError?: (error: string) => void;
}

export const ShareButton: React.FC<ShareButtonProps> = ({
  url,
  text = '',
  size = 18,
  className = '',
  onShare,
  onError,
}) => {
  const { isMiniApp } = useAuth();
  const [isAnimating, setIsAnimating] = useState(false);

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();

    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 300);

    try {
      if (isMiniApp) {
        // In miniapp: open Warpcast composer with pre-filled text + embed
        await sdk.actions.composeCast({
          text: text || undefined,
          embeds: [url],
        });
      } else if (navigator.share) {
        // Web: use native share API if available
        await navigator.share({ url, text });
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(url);
      }
      onShare?.();
    } catch (error) {
      // User cancelled share dialog is not an error
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Share failed:', error);
      onError?.('Failed to share');
    }
  };

  return (
    <div
      className={`share-button-container ${className} ${isAnimating ? 'share-animating' : ''}`}
      onClick={handleShare}
      title="Share"
      style={{ cursor: 'pointer' }}
    >
      <Share2 size={size} />
    </div>
  );
};

export default ShareButton;
