/**
 * GetQQModal — focused ETH → $QQ swap modal.
 *
 * Distilled from PointsModal.tsx (which mixes a points dashboard with the
 * swap). Self-contained for use anywhere we want to send a user to acquire
 * $QQ without leaving the app — e.g. the values quiz unlock panel.
 *
 * Caller passes `onSwapSuccess` to react after a tx is submitted (typically
 * to schedule a refetch of any gated UI state once the tx confirms).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, Loader2, X } from 'lucide-react';
import { formatEther, parseEther } from 'viem';
import { useFlaunch } from '../hooks/useFlaunch';
import { QQ_COIN_ADDRESS } from '../lib/consts';
import './GetQQModal.css';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSwapSuccess?: (txHash: string) => void;
  // Optional context line shown under the title, e.g. "hold ≥4.42M $QQ to unlock".
  contextLine?: string;
}

export const GetQQModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSwapSuccess,
  contextLine,
}) => {
  const { isConnected, connectWallet, walletClient, address, flaunchRead, flaunchWrite } =
    useFlaunch();

  const [swapAmount, setSwapAmount] = useState('');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);

  // Reset state on close; lock body scroll on open.
  useEffect(() => {
    if (!isOpen) {
      setSwapAmount('');
      setQuoteAmount('');
      setError(null);
      setSubmittedHash(null);
      return;
    }
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Debounced quote fetch.
  useEffect(() => {
    if (!swapAmount || parseFloat(swapAmount) === 0) {
      setQuoteAmount('');
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setIsLoadingQuote(true);
      setError(null);
      try {
        const amountIn = parseEther(swapAmount);
        const quote = await flaunchRead.getBuyQuoteExactInput({
          coinAddress: QQ_COIN_ADDRESS,
          amountIn,
        });
        if (!cancelled) setQuoteAmount(formatEther(quote));
      } catch (err) {
        console.error('quote failed:', err);
        if (!cancelled) setQuoteAmount('');
      } finally {
        if (!cancelled) setIsLoadingQuote(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [swapAmount, flaunchRead]);

  const handleSwap = useCallback(async () => {
    if (!flaunchWrite || !walletClient || !address) return;
    setIsSwapping(true);
    setError(null);
    try {
      const amountIn = parseEther(swapAmount);
      const hash = await flaunchWrite.buyCoin({
        coinAddress: QQ_COIN_ADDRESS,
        slippagePercent: 5,
        swapType: 'EXACT_IN',
        amountIn,
      });
      setSubmittedHash(hash as string);
      onSwapSuccess?.(hash as string);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e?.message || 'swap failed');
    } finally {
      setIsSwapping(false);
    }
  }, [flaunchWrite, walletClient, address, swapAmount, onSwapSuccess]);

  if (!isOpen) return null;

  return createPortal(
    <div className="getqq-overlay" onClick={onClose}>
      <div className="getqq-modal" onClick={(e) => e.stopPropagation()}>
        <button
          className="getqq-close"
          onClick={onClose}
          aria-label="close"
        >
          <X size={20} />
        </button>

        <h2 className="getqq-title">get $QQ</h2>
        {contextLine && <p className="getqq-context">{contextLine}</p>}

        {submittedHash ? (
          <div className="getqq-success">
            <p>swap submitted</p>
            <p className="getqq-hash">{submittedHash}</p>
            <p className="getqq-hint">
              your panel will unlock once the tx confirms — usually a few seconds.
            </p>
            <button className="getqq-action" onClick={onClose}>
              close
            </button>
          </div>
        ) : (
          <div className="getqq-swap">
            <label className="getqq-row">
              <span className="getqq-label">pay</span>
              <div className="getqq-input">
                <input
                  type="number"
                  placeholder="0.0"
                  value={swapAmount}
                  onChange={(e) => setSwapAmount(e.target.value)}
                />
                <span className="getqq-token">ETH</span>
              </div>
            </label>

            <ArrowDown size={16} className="getqq-arrow" />

            <label className="getqq-row">
              <span className="getqq-label">receive</span>
              <div className="getqq-input">
                <input
                  type="text"
                  placeholder="0.0"
                  value={isLoadingQuote ? '…' : quoteAmount}
                  readOnly
                />
                <span className="getqq-token">QQ</span>
              </div>
            </label>

            {error && <p className="getqq-error">{error}</p>}

            {!isConnected ? (
              <button className="getqq-action" onClick={connectWallet}>
                connect wallet
              </button>
            ) : (
              <button
                className="getqq-action"
                onClick={handleSwap}
                disabled={!swapAmount || isLoadingQuote || isSwapping}
              >
                {isSwapping ? (
                  <span className="getqq-spinner-row">
                    <Loader2 className="getqq-spin" size={16} /> swapping…
                  </span>
                ) : (
                  'swap'
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default GetQQModal;
