/**
 * BetaAccessModal Component
 * 
 * Modal shown to users who are not on the beta whitelist when they try to create an account.
 * Explains that qbase is in beta and provides an option to add the miniapp if in miniapp context.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X, Lock, Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './BetaAccessModal.css';

interface BetaAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BetaAccessModal: React.FC<BetaAccessModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { isMiniApp, addMiniApp, miniAppAdded } = useAuth();

  if (!isOpen) return null;

  const handleAddMiniApp = async () => {
    await addMiniApp();
  };

  return createPortal(
    <div className="beta-access-modal-overlay" onClick={onClose}>
      <div className="beta-access-modal-container" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>

        <div className="modal-content">
          <div className="modal-icon">
            <Lock size={48} strokeWidth={1.5} />
          </div>

          <h2>Beta Access Only</h2>
          
          <p className="modal-description">
            <strong>qbase</strong> is currently in private beta. Access is limited to users with a Neynar score {'>='} 0.9.
          </p>

          <div className="info-box">
            <p className="info-title">What is qbase?</p>
            <p className="info-text">
              qbase is a new way to share knowledge and opinions on Farcaster. 
              Ask questions, share answers, and discover what your network really thinks.
            </p>
          </div>

          <div className="info-box">
            <p className="info-title">How do I get access?</p>
            <p className="info-text">
              Earn a Neynar score {`>=`} 0.9. We may open up to more users before public launch. 
            </p>
          </div>

          {isMiniApp && !miniAppAdded && (
            <div className="add-miniapp-section">
              <p className="add-miniapp-text">
                Add qbase to get notified when you're invited:
              </p>
              <button className="add-miniapp-button" onClick={handleAddMiniApp}>
                <Plus size={18} />
                <span>Add qbase</span>
              </button>
            </div>
          )}

          {isMiniApp && miniAppAdded && (
            <div className="success-message">
              ✓ You've added qbase! We'll notify you when you get access.
            </div>
          )}

          <button className="dismiss-button" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default BetaAccessModal;

