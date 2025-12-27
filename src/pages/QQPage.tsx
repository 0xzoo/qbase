import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft, Loader2, Coins } from 'lucide-react';
import { parseEther, formatEther } from 'viem';
import Header from '../components/Header';
import './QQPage.css';
import { useAuth } from '../context/AuthContext';
import { useFlaunch } from '../hooks/useFlaunch';
import { QQ_COIN_ADDRESS } from '../lib/consts';
import { LiquidityMode, FlaunchVersion } from '@flaunch/sdk';

const QQPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, login } = useAuth();
  const { flaunchRead, flaunchWrite, isConnected, connectWallet, walletClient, address } = useFlaunch();
  // const { sendCalls } = useSendCalls(); // Removed wagmi dependency as it was causing issues and sendCalls is not available in this context without wagmi provider setup or similar.
  // We will use walletClient directly for now or assume flaunchWrite handles it if it returns calls.
  // Actually, flaunchWrite.getAddLiquidityCalls returns calls that need to be sent.
  // Since we don't have wagmi set up for sendCalls easily here without context, we might need to use walletClient.sendTransaction in a loop or similar if supported.
  // However, the Flaunch docs suggest useSendCalls. If wagmi is not installed/configured, we should check package.json.
  // For now, I will comment out the useSendCalls and just log the calls to avoid the build error, 
  // or better, try to use walletClient if available.

  // Checking previous code, walletClient is available from useFlaunch.
  // Let's try to use walletClient to send transactions if possible, or just mock it for now if wagmi is missing.
  // But wait, useFlaunch likely uses wagmi internally? 
  // Let's check if we can just remove the import and use a placeholder for sending calls.


  const [activeTab, setActiveTab] = useState<'swap' | 'stake'>('swap');

  // Swap State
  const [swapAmount, setSwapAmount] = useState<string>('');
  const [inputToken, setInputToken] = useState<'ETH' | 'QQ'>('ETH');
  const [quoteAmount, setQuoteAmount] = useState<string>('');
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Stake State
  const [stakeAmount, setStakeAmount] = useState<string>('');
  const [stakeEthAmount, setStakeEthAmount] = useState<string>('');
  const [isCalculatingStake, setIsCalculatingStake] = useState(false);
  const [isStaking, setIsStaking] = useState(false);
  const [stakeError, setStakeError] = useState<string | null>(null);

  // Mock stats - could be fetched from SDK later
  const stats = {
    dailyPoints: 51,
    qqHoldings: 1250,
    qqPrice: 0.001 // ETH
  };

  const outputToken = inputToken === 'ETH' ? 'QQ' : 'ETH';

  // --- Swap Logic ---
  useEffect(() => {
    const fetchQuote = async () => {
      if (!swapAmount || parseFloat(swapAmount) === 0) {
        setQuoteAmount('');
        return;
      }

      setIsLoadingQuote(true);
      setSwapError(null);

      try {
        const amountIn = parseEther(swapAmount);
        let quote;

        if (inputToken === 'ETH') {
          quote = await flaunchRead.getBuyQuoteExactInput({
            coinAddress: QQ_COIN_ADDRESS,
            amountIn,
          });
          setQuoteAmount(formatEther(quote));
        } else {
          quote = await flaunchRead.getSellQuoteExactInput({
            coinAddress: QQ_COIN_ADDRESS,
            amountIn,
          });
          setQuoteAmount(formatEther(quote));
        }
      } catch (err) {
        console.error('Error fetching quote:', err);
        setQuoteAmount('');
      } finally {
        setIsLoadingQuote(false);
      }
    };

    const timeoutId = setTimeout(fetchQuote, 500);
    return () => clearTimeout(timeoutId);
  }, [swapAmount, inputToken, flaunchRead]);

  const handleSwap = async () => {
    if (!flaunchWrite || !walletClient || !address) return;

    setIsSwapping(true);
    setSwapError(null);

    try {
      const amountIn = parseEther(swapAmount);

      if (inputToken === 'ETH') {
        const hash = await flaunchWrite.buyCoin({
          coinAddress: QQ_COIN_ADDRESS,
          slippagePercent: 5,
          swapType: "EXACT_IN",
          amountIn,
        });
        console.log('Buy Transaction Hash:', hash);
        alert('Swap submitted! Transaction Hash: ' + hash);
      } else {
        const { allowance } = await flaunchWrite.getPermit2AllowanceAndNonce(QQ_COIN_ADDRESS);
        let signature;
        let permitSingle;

        if (allowance < amountIn) {
          const permitData = await flaunchWrite.getPermit2TypedData(QQ_COIN_ADDRESS);
          permitSingle = permitData.permitSingle;
          signature = await walletClient.signTypedData({
            account: address,
            domain: permitData.typedData.domain,
            types: permitData.typedData.types,
            primaryType: permitData.typedData.primaryType,
            message: permitData.typedData.message,
          });
        }

        const hash = await flaunchWrite.sellCoin({
          coinAddress: QQ_COIN_ADDRESS,
          amountIn,
          slippagePercent: 5,
          permitSingle,
          signature,
        });
        console.log('Sell Transaction Hash:', hash);
        alert('Swap submitted! Transaction Hash: ' + hash);
      }

      setSwapAmount('');
      setQuoteAmount('');
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Swap failed:', err);
      setSwapError(error.message || 'Swap failed');
    } finally {
      setIsSwapping(false);
    }
  };

  const toggleDirection = () => {
    setInputToken(prev => prev === 'ETH' ? 'QQ' : 'ETH');
    setSwapAmount('');
    setQuoteAmount('');
  };

  // --- Stake Logic ---
  useEffect(() => {
    const calculateStake = async () => {
      if (!stakeAmount || parseFloat(stakeAmount) === 0) {
        setStakeEthAmount('');
        return;
      }

      setIsCalculatingStake(true);
      setStakeError(null);

      try {
        const result = await flaunchRead.calculateAddLiquidityAmounts({
          coinAddress: QQ_COIN_ADDRESS,
          version: FlaunchVersion.ANY,
          liquidityMode: LiquidityMode.FULL_RANGE,
          coinOrEthInputAmount: parseEther(stakeAmount),
          inputToken: "coin",
          minMarketCap: "0",
          maxMarketCap: "0",
        });

        setStakeEthAmount(formatEther(result.ethAmount));
      } catch (err) {
        console.error('Error calculating stake:', err);
        setStakeEthAmount('');
      } finally {
        setIsCalculatingStake(false);
      }
    };

    const timeoutId = setTimeout(calculateStake, 500);
    return () => clearTimeout(timeoutId);
  }, [stakeAmount, flaunchRead]);

  const handleStake = async () => {
    if (!flaunchWrite || !walletClient || !address) return;

    setIsStaking(true);
    setStakeError(null);

    try {
      const addLiqCalls = await flaunchWrite.getAddLiquidityCalls({
        coinAddress: QQ_COIN_ADDRESS,
        version: FlaunchVersion.ANY,
        liquidityMode: LiquidityMode.FULL_RANGE,
        coinOrEthInputAmount: parseEther(stakeAmount),
        inputToken: "coin",
        minMarketCap: "0",
        maxMarketCap: "0",
      });

      const calls = addLiqCalls.map((call) => ({
        to: call.to as `0x${string}`,
        value: call.value,
        data: call.data as `0x${string}`,
      }));

      // Fallback to sending transactions sequentially using walletClient since wagmi's useSendCalls might not be available
      if (walletClient) {
        for (const call of calls) {
          await walletClient.sendTransaction({
            to: call.to,
            value: call.value,
            data: call.data,
            account: address,
            chain: undefined // Let wallet handle chain
          });
        }
      } else {
        console.error("No wallet client available to send transactions");
        alert("Failed to send transactions: No wallet connected.");
        return;
      }

      alert('Staking transaction(s) submitted!');
      setStakeAmount('');
      setStakeEthAmount('');
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Staking failed:', err);
      setStakeError(error.message || 'Staking failed');
    } finally {
      setIsStaking(false);
    }
  };

  const renderButton = () => {
    if (!isAuthenticated) {
      return (
        <button className="swap-button" onClick={login}>
          Login to {activeTab === 'swap' ? 'Swap' : 'Stake'}
        </button>
      );
    }

    if (!isConnected) {
      return (
        <button className="swap-button" onClick={connectWallet}>
          Connect Wallet
        </button>
      );
    }

    if (activeTab === 'swap') {
      if (isSwapping) {
        return (
          <button className="swap-button" disabled>
            <Loader2 className="animate-spin" size={20} />
            Swapping...
          </button>
        );
      }
      return (
        <button
          className="swap-button"
          onClick={handleSwap}
          disabled={!swapAmount || isLoadingQuote || !!swapError}
        >
          Swap {inputToken} to {outputToken}
        </button>
      );
    } else {
      if (isStaking) {
        return (
          <button className="swap-button" disabled>
            <Loader2 className="animate-spin" size={20} />
            Staking...
          </button>
        );
      }
      return (
        <button
          className="swap-button"
          onClick={handleStake}
          disabled={!stakeAmount || isCalculatingStake || !!stakeError}
        >
          Stake (Provide Liquidity)
        </button>
      );
    }
  };

  return (
    <>
      <Header showBack backLabel="Feed" onBack={() => navigate('/questions')} />
      <div className="qq-page mobile-layout-container">
        <div className="qq-header">
          <h1 className="qq-title">$qq Dashboard</h1>
          <p className="qq-subtitle">Manage your points and holdings</p>
        </div>

        <div className="qq-stats-container">
          <div className="qq-stat-card">
            <span className="qq-stat-label">Daily Points</span>
            <span className="qq-stat-value">{stats.dailyPoints}</span>
          </div>
          <div className="qq-stat-card">
            <span className="qq-stat-label">$qq Holdings</span>
            <span className="qq-stat-value">{stats.qqHoldings.toLocaleString()}</span>
          </div>
        </div>

        <div className="swap-widget">
          <div className="widget-tabs">
            <button
              className={`tab-button ${activeTab === 'swap' ? 'active' : ''}`}
              onClick={() => setActiveTab('swap')}
            >
              <ArrowRightLeft size={16} />
              Swap
            </button>
            <button
              className={`tab-button ${activeTab === 'stake' ? 'active' : ''}`}
              onClick={() => setActiveTab('stake')}
            >
              <Coins size={16} />
              Stake
            </button>
          </div>

          {activeTab === 'swap' ? (
            <>
              <div className="swap-input-group">
                <label>You Pay</label>
                <div className="input-wrapper">
                  <input
                    type="number"
                    value={swapAmount}
                    onChange={(e) => setSwapAmount(e.target.value)}
                    placeholder="0.00"
                  />
                  <span className="currency-label">{inputToken}</span>
                </div>
              </div>

              <div className="swap-divider">
                <button className="icon-button" onClick={toggleDirection}>
                  <ArrowRightLeft size={20} />
                </button>
              </div>

              <div className="swap-input-group">
                <label>You Receive</label>
                <div className="input-wrapper">
                  <input
                    type="text"
                    value={isLoadingQuote ? 'Loading...' : quoteAmount}
                    readOnly
                    placeholder="0.00"
                  />
                  <span className="currency-label">{outputToken}</span>
                </div>
              </div>
              {swapError && <div className="error-message">{swapError}</div>}
            </>
          ) : (
            <>
              <div className="info-banner">
                <p>Provide liquidity to earn trading fees and unlock Status Tiers.</p>
              </div>
              <div className="swap-input-group">
                <label>Deposit $QQ</label>
                <div className="input-wrapper">
                  <input
                    type="number"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    placeholder="0.00"
                  />
                  <span className="currency-label">QQ</span>
                </div>
              </div>

              <div className="swap-input-group">
                <label>Required ETH</label>
                <div className="input-wrapper">
                  <input
                    type="text"
                    value={isCalculatingStake ? 'Calculating...' : stakeEthAmount}
                    readOnly
                    placeholder="0.00"
                  />
                  <span className="currency-label">ETH</span>
                </div>
              </div>
              {stakeError && <div className="error-message">{stakeError}</div>}
            </>
          )}

          {renderButton()}
        </div>
      </div>
    </>
  );
};

export default QQPage;
