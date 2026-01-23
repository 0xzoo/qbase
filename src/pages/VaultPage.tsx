/**
 * VaultPage - Private Answers with E2E Encryption
 * 
 * Displays user's end-to-end encrypted private answers stored in Nillion.
 * Requires wallet connection and key derivation to decrypt.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Shield, Wallet, Key, RefreshCw, Eye, EyeOff, ChevronRight } from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../context/AuthContext';
import { usePrivateAnswerRead } from '../hooks/usePrivateAnswerRead';
import { WalletConnectModal } from '../components/WalletConnectModal';
import LoadingAnimation from '../components/LoadingAnimation';
import './VaultPage.css';

interface VaultAnswerCardProps {
  answer: {
    _id: string;
    q_id: string;
    value: string;
    created_at: string;
    primary_type?: string;
  };
  onViewQuestion: (qId: string) => void;
}

const VaultAnswerCard: React.FC<VaultAnswerCardProps> = ({ answer, onViewQuestion }) => {
  const [isRevealed, setIsRevealed] = useState(false);
  
  const formattedDate = new Date(answer.created_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Value is now always plain display text
  const displayValue = answer.value;

  return (
    <div className="vault-answer-card">
      <div className="vault-answer-header">
        <div className="vault-answer-meta">
          <span className="vault-answer-date">{formattedDate}</span>
          {answer.primary_type && (
            <span className="vault-answer-type">{answer.primary_type}</span>
          )}
        </div>
        <button 
          className="vault-reveal-btn"
          onClick={() => setIsRevealed(!isRevealed)}
          title={isRevealed ? 'Hide answer' : 'Reveal answer'}
        >
          {isRevealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      
      <div className={`vault-answer-content ${isRevealed ? 'revealed' : 'hidden'}`}>
        {isRevealed ? (
          <p>{displayValue}</p>
        ) : (
          <p className="vault-answer-masked">••••••••••••••••</p>
        )}
      </div>
      
      <button 
        className="vault-view-question-btn"
        onClick={() => onViewQuestion(answer.q_id)}
      >
        View Question <ChevronRight size={14} />
      </button>
    </div>
  );
};

const VaultPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const {
    answers,
    isLoading,
    error,
    refresh,
    canRead,
    needsWalletConnection,
    needsKeyDerivation,
  } = usePrivateAnswerRead();

  const [showWalletModal, setShowWalletModal] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false);

  // Reset load attempt flag when canRead changes to false
  useEffect(() => {
    if (!canRead) {
      setHasAttemptedLoad(false);
    }
  }, [canRead]);

  // Auto-refresh when we can read (only once per session)
  useEffect(() => {
    console.log('[VaultPage] Effect check - canRead:', canRead, 'hasAttemptedLoad:', hasAttemptedLoad, 'isLoading:', isLoading, 'needsWallet:', needsWalletConnection, 'needsKey:', needsKeyDerivation);
    if (canRead && !hasAttemptedLoad && !isLoading) {
      console.log('[VaultPage] Triggering refresh...');
      setHasAttemptedLoad(true);
      refresh();
    }
  }, [canRead, hasAttemptedLoad, isLoading, refresh, needsWalletConnection, needsKeyDerivation]);

  const handleUnlock = async () => {
    if (needsWalletConnection) {
      setShowWalletModal(true);
    } else if (needsKeyDerivation) {
      setIsUnlocking(true);
      try {
        await refresh();
      } finally {
        setIsUnlocking(false);
      }
    }
  };

  const handleWalletConnected = () => {
    setShowWalletModal(false);
    // After wallet connect, trigger refresh which will derive key
    handleUnlock();
  };

  if (!isAuthenticated) {
    return (
      <div className="vault-page">
        <Header title="My Vault" />
        <div className="vault-container vault-unauthenticated">
          <div className="vault-lock-icon">
            <Lock size={48} />
          </div>
          <h2>Sign in to access your vault</h2>
          <p>Your private answers are encrypted and only accessible to you.</p>
        </div>
      </div>
    );
  }

  const isLocked = !canRead;

  return (
    <div className="vault-page">
      <Header title="My Vault" />
      
      <div className="vault-container">
        {/* Vault Header */}
        <div className="vault-header">
          <div className="vault-title-row">
            <div className="vault-icon">
              <Shield size={28} />
            </div>
            <div>
              <h1>My Vault</h1>
              <p className="vault-subtitle">End-to-end encrypted answers</p>
            </div>
          </div>
          
          {canRead && (
            <button 
              className="vault-refresh-btn"
              onClick={refresh}
              disabled={isLoading}
            >
              <RefreshCw size={18} className={isLoading ? 'spinning' : ''} />
            </button>
          )}
        </div>

        {/* Locked State */}
        {isLocked && (
          <div className="vault-locked-state">
            <div className="vault-locked-visual">
              <div className="vault-lock-circle">
                <Lock size={32} />
              </div>
              <div className="vault-lock-rings" />
            </div>
            
            <h2>Vault Locked</h2>
            <p>
              {needsWalletConnection 
                ? 'Connect your wallet to unlock your encrypted answers.'
                : 'Sign with your wallet to derive your encryption key.'}
            </p>
            
            <button 
              className="vault-unlock-btn"
              onClick={handleUnlock}
              disabled={isUnlocking}
            >
              {isUnlocking ? (
                <>
                  <LoadingAnimation variant="spinner" size="sm" />
                  <span>Unlocking...</span>
                </>
              ) : needsWalletConnection ? (
                <>
                  <Wallet size={20} />
                  <span>Connect Wallet</span>
                </>
              ) : (
                <>
                  <Key size={20} />
                  <span>Unlock Vault</span>
                </>
              )}
            </button>

            <div className="vault-security-note">
              <Shield size={14} />
              <span>Your data is encrypted in your browser—we never see it.</span>
            </div>
          </div>
        )}

        {/* Unlocked State */}
        {canRead && (
          <div className="vault-unlocked-state">
            {isLoading ? (
              <div className="vault-loading">
                <LoadingAnimation variant="spinner" size="md" />
                <p>Decrypting your answers...</p>
              </div>
            ) : error ? (
              <div className="vault-error">
                <p>{error}</p>
                <button onClick={refresh}>Try Again</button>
              </div>
            ) : answers.length === 0 ? (
              <div className="vault-empty">
                <div className="vault-empty-icon">
                  <Lock size={40} />
                </div>
                <h3>Your vault is empty</h3>
                <p>Private answers you submit will appear here, encrypted and accessible only to you.</p>
                <button 
                  className="vault-browse-btn"
                  onClick={() => navigate('/questions')}
                >
                  Browse Questions
                </button>
              </div>
            ) : (
              <div className="vault-answers-list">
                <div className="vault-answers-header">
                  <span className="vault-count">{answers.length} private answer{answers.length !== 1 ? 's' : ''}</span>
                </div>
                {answers.map((answer) => (
                  <VaultAnswerCard
                    key={answer._id}
                    answer={answer}
                    onViewQuestion={(qId) => navigate(`/question/${qId}`)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <WalletConnectModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnected={handleWalletConnected}
      />
    </div>
  );
};

export default VaultPage;

