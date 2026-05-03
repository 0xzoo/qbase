import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowDown, Wallet, Loader2 } from 'lucide-react';
import { parseEther, formatEther } from 'viem';
import { useFlaunch } from '../hooks/useFlaunch';
import { QQ_COIN_ADDRESS } from '../lib/consts';
import './PointsModal.css';

interface PointsModalProps {
  isOpen: boolean;
  onClose: () => void;
  points: {
    allowance: number;
    earned: number;
    balance: number;
  } | null;
}

export const PointsModal: React.FC<PointsModalProps> = ({ isOpen, onClose, points }) => {
  const { isConnected, connectWallet, walletClient, address } = useFlaunch();
  const { flaunchRead, flaunchWrite } = useFlaunch();

  const [swapAmount, setSwapAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when closing
  useEffect(() => {
    if (!isOpen) {
      setSwapAmount('');
      setQuoteAmount('');
      setError(null);
    } else {
        // Prevent body scroll when modal is open
        document.body.style.overflow = 'hidden';
    }
    return () => {
        document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Quote Logic (ETH -> QQ only for simplicity in this modal for now, or bi-directional?)
  // Let's stick to ETH -> QQ buy for "Getting Started" feel, or maybe bi-directional toggle later.
  // For now: Simple "Buy $QQ" flow.
  useEffect(() => {
    const fetchQuote = async () => {
      if (!swapAmount || parseFloat(swapAmount) === 0) {
        setQuoteAmount('');
        return;
      }

      setIsLoadingQuote(true);
      setError(null);

      try {
        const amountIn = parseEther(swapAmount);
        // Assuming ETH -> QQ buy
        const quote = await flaunchRead.getBuyQuoteExactInput({
          coinAddress: QQ_COIN_ADDRESS,
          amountIn,
        });
        setQuoteAmount(formatEther(quote));
      } catch (err) {
        console.error('Error fetching quote:', err);
        setQuoteAmount('');
      } finally {
        setIsLoadingQuote(false);
      }
    };

    const timeoutId = setTimeout(fetchQuote, 500);
    return () => clearTimeout(timeoutId);
  }, [swapAmount, flaunchRead]);

  const handleSwap = async () => {
    if (!flaunchWrite || !walletClient || !address) return;

    setIsSwapping(true);
    setError(null);

    try {
      const amountIn = parseEther(swapAmount);
      const hash = await flaunchWrite.buyCoin({
        coinAddress: QQ_COIN_ADDRESS,
        slippagePercent: 5,
        swapType: "EXACT_IN",
        amountIn,
      });
      console.log('Buy Transaction Hash:', hash);
      alert('Swap submitted! Hash: ' + hash); // Simple alert for now
      setSwapAmount('');
      setQuoteAmount('');
    } catch (err: unknown) {
      const e = err as { message?: string };
      console.error('Swap failed:', err);
      setError(e.message || 'Swap failed');
    } finally {
      setIsSwapping(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="points-modal-overlay" onClick={onClose}>
      <div className="points-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="points-modal-header">
          <button className="close-btn" onClick={onClose}>
            <X size={24} />
          </button>
        </div>

        <div className="points-section">
          <div className="section-title">Your Points</div>
          <div className="points-grid">
            <div className="points-card">
              <span className="point-value">{points?.allowance ?? 0}</span>
              <span className="point-label">Remaining Allowance</span>
            </div>
            <div className="points-card">
              <span className="point-value">{points?.earned ?? 0}</span>
              <span className="point-label">Earned (Monthly)</span>
            </div>
            <div className="points-card">
              <span className="point-value">
                {(points?.balance ?? 0)}
              </span>
              <span className="point-label">Balance</span>
            </div>
            <div className="points-card">
              <span className="point-value" style={{ color: '#4CAF50' }}>
                {(points?.allowance ?? 0) + (points?.balance ?? 0)}
              </span>
              <span className="point-label">Total Spendable</span>
            </div>
          </div>
        </div>

        <div className="qq-section">
          <div className="section-title">Token ($QQ)</div>
          
          <div className="wallet-balance">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Wallet size={16} />
              <span>Wallet Balance</span>
            </div>
            <span>{isConnected ? 'Connected' : 'Not Connected'}</span>
          </div>

          <div className="swap-container">
            <div className="swap-input-row">
              <span className="input-label">Pay (ETH)</span>
              <div className="input-field-wrapper">
                <input
                  type="number"
                  className="amount-input"
                  placeholder="0.0"
                  value={swapAmount}
                  onChange={(e) => setSwapAmount(e.target.value)}
                />
                <span className="token-badge">ETH</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
                <ArrowDown size={16} style={{ opacity: 0.5 }} />
            </div>

            <div className="swap-input-row">
               <span className="input-label">Receive ($QQ)</span>
              <div className="input-field-wrapper">
                <input
                  type="text"
                  className="amount-input"
                  placeholder="0.0"
                  value={isLoadingQuote ? '...' :quoteAmount}
                  readOnly
                />
                <span className="token-badge">QQ</span>
              </div>
            </div>

            {error && <div style={{ color: '#ff6b6b', fontSize: '0.9rem', textAlign: 'center' }}>{error}</div>}

            {!isConnected ? (
              <button className="swap-action-btn" onClick={connectWallet}>
                Connect Wallet
              </button>
            ) : (
                <button 
                    className="swap-action-btn"
                    onClick={handleSwap}
                    disabled={!swapAmount || isLoadingQuote || isSwapping}
                >
                    {isSwapping ? (
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                            <Loader2 className="animate-spin" size={18} /> Swapping...
                        </span>
                    ) : 'Swap ETH to QQ'}
                </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
