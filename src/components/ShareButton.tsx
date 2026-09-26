/**
 * ShareButton Component
 *
 * Generic share button: composeCast in miniapp mode, native share or the
 * clipboard on web. With `actions` (e.g. "Share to Farcaster" for a viewer
 * with a linked Farcaster account) a click opens a small menu instead:
 * "Share link" plus those actions.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useAuth } from '../context/AuthContext';
import './ShareButton.css';

export interface ShareAction {
  label: string;
  onSelect: () => void | Promise<void>;
}

interface ShareButtonProps {
  /** URL to share */
  url: string;
  /** Pre-filled text for the share */
  text?: string;
  /** Icon size */
  size?: number;
  /** Additional CSS classes */
  className?: string;
  /** Extra menu items; when present a click opens the menu */
  actions?: ShareAction[];
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
  actions = [],
  onShare,
  onError,
}) => {
  const { isMiniApp } = useAuth();
  const [isAnimating, setIsAnimating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const shareLink = async () => {
    try {
      if (isMiniApp) {
        // In miniapp: open the Farcaster composer with pre-filled text + embed
        await sdk.actions.composeCast({
          text: text || undefined,
          embeds: [url],
        });
      } else if (navigator.share) {
        // Web: use native share API if available. Only share the URL —
        // passing `text` alongside `url` causes the text to be appended
        // after the URL in the shared message on most platforms.
        await navigator.share({ url });
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

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 300);
    if (actions.length > 0) {
      setMenuOpen((open) => !open);
      return;
    }
    await shareLink();
  };

  const pick = (run: () => void | Promise<void>) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    await run();
  };

  return (
    <div
      ref={containerRef}
      className={`share-button-container ${className} ${isAnimating ? 'share-animating' : ''}`}
      onClick={handleClick}
      title="Share"
      style={{ cursor: 'pointer' }}
      aria-haspopup={actions.length > 0 ? 'menu' : undefined}
      aria-expanded={actions.length > 0 ? menuOpen : undefined}
    >
      <Share2 size={size} />
      {menuOpen && (
        <div className="share-menu" role="menu">
          <button type="button" role="menuitem" className="share-menu-item" onClick={pick(shareLink)}>
            Share link
          </button>
          {actions.map((a) => (
            <button key={a.label} type="button" role="menuitem" className="share-menu-item" onClick={pick(a.onSelect)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ShareButton;
