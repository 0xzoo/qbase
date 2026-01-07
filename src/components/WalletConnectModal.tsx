/**
 * WalletConnectModal
 * 
 * Modal for connecting a wallet to enable E2E encrypted private answers.
 * Shows different UI for:
 * - MiniApp (Warpcast wallet via Farcaster connector)
 * - Web browser (MetaMask, Rainbow, etc.)
 */

import React from 'react';
import { useConnect, useAccount, useDisconnect } from 'wagmi';
import { useAuth } from '../context/AuthContext';
import { Wallet, CheckCircle, X, Shield } from 'lucide-react';
import './WalletConnectModal.css';

interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: () => void;
}

export function WalletConnectModal({ 
  isOpen, 
  onClose,
  onConnected 
}: WalletConnectModalProps) {
  const { connectors, connect, isPending, error } = useConnect();
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const { isMiniApp } = useAuth();

  if (!isOpen) return null;

  const handleConnect = async (connector: typeof connectors[number]) => {
    try {
      connect({ connector }, {
        onSuccess: () => {
          onConnected?.();
        },
      });
    } catch (err) {
      console.error('Failed to connect wallet:', err);
    }
  };

  const handleContinue = () => {
    onConnected?.();
    onClose();
  };

  // Get friendly connector names
  const getConnectorName = (connector: typeof connectors[number]) => {
    if (connector.id === 'farcasterMiniApp') {
      return 'Warpcast Wallet';
    }
    if (connector.id === 'injected') {
      return 'Browser Wallet';
    }
    return connector.name;
  };

  // Filter connectors based on environment
  const availableConnectors = connectors.filter(c => {
    // In MiniApp, prioritize the Farcaster connector
    if (isMiniApp && c.id === 'farcasterMiniApp') return true;
    // In browser, show injected wallets
    if (!isMiniApp && c.id === 'injected') return true;
    // Show all for flexibility
    return true;
  });

  return (
    <div className="wallet-modal-overlay" onClick={onClose}>
      <div className="wallet-modal-content" onClick={e => e.stopPropagation()}>
        <button className="wallet-modal-close" onClick={onClose}>
          <X size={20} />
        </button>

        <div className="wallet-modal-header">
          <div className="wallet-modal-icon">
            <Shield size={32} />
          </div>
          <h2>Secure Your Private Answers</h2>
          <p>
            Connect your wallet to enable end-to-end encryption.
            Your private answers will be encrypted in your browser before
            being stored—only you can decrypt them.
          </p>
        </div>

        {isConnected ? (
          <div className="wallet-modal-connected">
            <div className="wallet-connected-badge">
              <CheckCircle size={20} />
              <span>Wallet Connected</span>
            </div>
            <div className="wallet-address">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </div>
            <button 
              className="wallet-modal-button primary"
              onClick={handleContinue}
            >
              Continue
            </button>
            <button 
              className="wallet-modal-button secondary"
              onClick={() => disconnect()}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="wallet-modal-options">
            {availableConnectors.map((connector) => (
              <button
                key={connector.id}
                className="wallet-connector-button"
                onClick={() => handleConnect(connector)}
                disabled={isPending}
              >
                <Wallet size={20} />
                <span>{getConnectorName(connector)}</span>
                {isPending && <span className="wallet-connecting">Connecting...</span>}
              </button>
            ))}

            {error && (
              <div className="wallet-error">
                {error.message || 'Failed to connect wallet'}
              </div>
            )}
          </div>
        )}

        <div className="wallet-modal-footer">
          <p className="wallet-privacy-note">
            Your wallet signs a message to derive your encryption key.
            No transaction is sent—this is free and secure.
          </p>
        </div>
      </div>
    </div>
  );
}

export default WalletConnectModal;

