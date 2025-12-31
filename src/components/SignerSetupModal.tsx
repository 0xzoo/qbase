/**
 * SignerSetupModal Component
 * 
 * Modal that prompts users to create a Farcaster signer when they try to perform
 * actions that require write permissions (liking, posting, sharing to Farcaster).
 * 
 * Usage:
 * const [showSignerModal, setShowSignerModal] = useState(false);
 * <SignerSetupModal 
 *   isOpen={showSignerModal} 
 *   onClose={() => setShowSignerModal(false)}
 *   action="like this content"
 * />
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { SignerCreationButton } from './SignerCreationButton';
import './SignerSetupModal.css';

interface SignerSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The action the user is trying to perform (e.g., "like this content", "share to Farcaster") */
  action?: string;
  /** Custom message to display instead of default */
  customMessage?: string;
}

export const SignerSetupModal: React.FC<SignerSetupModalProps> = ({
  isOpen,
  onClose,
  action = "perform this action",
  customMessage,
}) => {
  if (!isOpen) return null;

  return createPortal(
    <div className="signer-setup-modal-overlay" onClick={onClose}>
      <div className="signer-setup-modal-container" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>

        <div className="modal-content">
          <div className="modal-icon">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="20" fill="#7c65c1" opacity="0.1" />
              <path
                d="M24 14V24M24 30H24.01M24 44C12.954 44 4 35.046 4 24S12.954 4 24 4s20 8.954 20 20-8.954 20-20 20z"
                stroke="#7c65c1"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <h2>Authorization Required</h2>
          
          <p className="modal-description">
            {customMessage || (
              <>
                To <strong>{action}</strong>, you need to authorize qbase to act on your behalf on Farcaster.
              </>
            )}
          </p>

          <div className="info-box">
            <p className="info-title">What is a signer?</p>
            <p className="info-text">
              A signer is a secure key that allows qbase to publish content or interact with Farcaster on your behalf. 
              You'll approve it once in Farcaster, and you can revoke it anytime.
            </p>
          </div>

          <div className="auth-section">
            <SignerCreationButton 
              onSuccess={() => {
                console.log('[SignerSetupModal] Signer created successfully');
                // Close modal after successful signer creation  
                setTimeout(() => {
                  console.log('[SignerSetupModal] Closing modal');
                  onClose();
                }, 1000);
              }}
              onError={(error) => {
                console.error('[SignerSetupModal] Signer setup error:', error);
              }}
            />
          </div>

          <p className="security-note">
            🔒 Secure & revocable - You maintain full control over your account
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default SignerSetupModal;

