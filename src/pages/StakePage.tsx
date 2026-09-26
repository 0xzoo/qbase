/**
 * StakePage — /stake: deposit $QQ into OracleEscrow (credited to the viewer's
 * FID), see the available stake, withdraw after the 7-day settlement window.
 * The council deducts its price from this stake per summon.
 * Spec: docs/specs/paid-council.md. Precedent for the wallet flow: BartletUnlock.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { erc20Abi, parseAbi, parseUnits, formatUnits } from 'viem';
import { base } from 'wagmi/chains';
import { Loader2, Coins, Wallet, AlertCircle } from 'lucide-react';
import Header from '../components/Header';
import { WalletConnectModal } from '../components/WalletConnectModal';
import { useAuth } from '../context/AuthContext';
import type { CouncilConfig, CouncilStake } from '../lib/types';
import './StakePage.css';

const ESCROW_ABI = parseAbi([
  'function deposit(uint256 fid, uint256 amount)',
  'function withdraw(uint256 fid, uint256 amount)',
  'function availableBalance(uint256 fid) view returns (uint256)',
  'function cooldownRemaining(uint256 fid) view returns (uint256)',
]);

const QQ_DECIMALS = 18;

function whole(wei: bigint | string | null | undefined): string {
  if (wei === null || wei === undefined) return '0';
  try {
    return Number(formatUnits(BigInt(wei), QQ_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  } catch {
    return '0';
  }
}

function cooldownLabel(seconds: number): string {
  if (seconds <= 0) return 'ready';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

type Step = 'idle' | 'approving' | 'depositing' | 'withdrawing';

const StakePage: React.FC = () => {
  const navigate = useNavigate();
  // TODO(account-root): OracleEscrow stakes are keyed by Farcaster fid on
  // chain; an account without Farcaster cannot stake until the escrow (or a
  // server mapping) accepts account ids.
  const { isAuthenticated, login, getAuthToken, fid: farcasterFid } = useAuth();
  const fid = farcasterFid ?? undefined;

  const [config, setConfig] = useState<CouncilConfig | null>(null);
  const [stake, setStake] = useState<CouncilStake | null>(null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();
  const [walletOpen, setWalletOpen] = useState(false);

  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: pendingHash });

  const escrow = config?.escrow_address as `0x${string}` | null | undefined;
  const qq = config?.qq_address as `0x${string}` | null | undefined;

  const loadStake = useCallback(async (fresh = false) => {
    const token = getAuthToken();
    if (!token) return;
    try {
      const res = await fetch(`/api/council/stake${fresh ? '?fresh=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setStake(await res.json() as CouncilStake);
    } catch (e) {
      console.warn('[Stake] load failed', e);
    }
  }, [getAuthToken]);

  useEffect(() => {
    fetch('/api/council/config').then(r => r.json()).then(c => setConfig(c as CouncilConfig)).catch(() => setConfig(null));
  }, []);

  useEffect(() => { if (isAuthenticated) void loadStake(); }, [isAuthenticated, loadStake]);

  // After a mined deposit / withdraw, re-read the stake (bypassing the 30 s cache).
  useEffect(() => {
    if (receipt.isSuccess && pendingHash) {
      setPendingHash(undefined);
      setStep('idle');
      setAmount('');
      void loadStake(true);
    }
  }, [receipt.isSuccess, pendingHash, loadStake]);

  const { data: walletQQ } = useReadContract({
    address: qq ?? undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!qq && !!address },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: qq ?? undefined,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && escrow ? [address, escrow] : undefined,
    query: { enabled: !!qq && !!address && !!escrow },
  });

  const amountWei = useMemo(() => {
    try {
      return amount && /^\d+(\.\d+)?$/.test(amount) ? parseUnits(amount, QQ_DECIMALS) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  const busy = step !== 'idle' || (!!pendingHash && receipt.isLoading);

  const deposit = async () => {
    if (!fid || !escrow || !qq || !address || amountWei <= 0n) return;
    setError(null);
    try {
      if (!allowance || allowance < amountWei) {
        setStep('approving');
        const approveHash = await writeContractAsync({
          address: qq, abi: erc20Abi, functionName: 'approve', args: [escrow, amountWei], chain: base, account: address,
        });
        // Wait for the approval to land before deposit reads the allowance.
        await waitFor(approveHash);
        await refetchAllowance();
      }
      setStep('depositing');
      const hash = await writeContractAsync({
        address: escrow, abi: ESCROW_ABI, functionName: 'deposit', args: [BigInt(fid), amountWei], chain: base, account: address,
      });
      setPendingHash(hash);
    } catch (e) {
      setStep('idle');
      const msg = e instanceof Error ? e.message : 'Deposit failed';
      setError(/rejected|denied/i.test(msg) ? null : msg.split('\n')[0].slice(0, 200));
    }
  };

  const withdraw = async () => {
    if (!fid || !escrow || !address || amountWei <= 0n) return;
    setError(null);
    try {
      setStep('withdrawing');
      const hash = await writeContractAsync({
        address: escrow, abi: ESCROW_ABI, functionName: 'withdraw', args: [BigInt(fid), amountWei], chain: base, account: address,
      });
      setPendingHash(hash);
    } catch (e) {
      setStep('idle');
      const msg = e instanceof Error ? e.message : 'Withdraw failed';
      setError(/rejected|denied/i.test(msg) ? null : msg.split('\n')[0].slice(0, 200));
    }
  };

  const cooldown = stake?.cooldown_remaining ?? 0;
  const canWithdraw = cooldown <= 0 && stake?.balance && BigInt(stake.balance) >= amountWei && amountWei > 0n;

  return (
    <div className="stake-page-wrapper">
      <Header showBack backLabel="Back" onBack={() => navigate(-1)} title="Stake" />
      <div className="stake-page mobile-layout-container">
        <h1 className="stake-title"><Coins size={22} /> $QQ stake</h1>
        <p className="stake-lede">
          The council answers from your stake.
          {config?.gated
            ? ` Each summon costs ${Number(config.price).toLocaleString()} $QQ.`
            : ' Summons are free right now; a price will be announced.'}
          {' '}Withdrawals open 7 days after your last deposit.
        </p>

        {!config?.escrow_address ? (
          <div className="stake-card stake-card--muted">
            <AlertCircle size={18} />
            <span>Staking is not open yet. Check back once the escrow is live.</span>
          </div>
        ) : !isAuthenticated ? (
          <div className="stake-card">
            <p>Sign in with Farcaster to see and fund your stake.</p>
            <button type="button" className="stake-btn" onClick={() => login()}>Sign in</button>
          </div>
        ) : (
          <>
            <div className="stake-stats">
              <div className="stake-stat">
                <span className="stake-stat-label">Available</span>
                <span className="stake-stat-value">{whole(stake?.balance)} $QQ</span>
              </div>
              <div className="stake-stat">
                <span className="stake-stat-label">Summons left</span>
                <span className="stake-stat-value">{stake?.summons_remaining ?? '∞'}</span>
              </div>
              <div className="stake-stat">
                <span className="stake-stat-label">Withdraw</span>
                <span className="stake-stat-value">{cooldownLabel(cooldown)}</span>
              </div>
            </div>

            {!isConnected ? (
              <div className="stake-card">
                <p>Connect the wallet that holds your $QQ.</p>
                <button type="button" className="stake-btn" onClick={() => setWalletOpen(true)}>
                  <Wallet size={16} /> Connect wallet
                </button>
              </div>
            ) : (
              <div className="stake-card">
                <div className="stake-wallet-row">
                  <span className="stake-wallet-addr">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
                  <span className="stake-wallet-bal">{whole(walletQQ as bigint | undefined)} $QQ in wallet</span>
                </div>
                <label className="stake-amount-label" htmlFor="stake-amount">Amount ($QQ)</label>
                <input
                  id="stake-amount"
                  className="stake-amount"
                  inputMode="decimal"
                  placeholder={config?.gated ? config.price : '0'}
                  value={amount}
                  onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                  disabled={busy}
                />
                <div className="stake-actions">
                  <button type="button" className="stake-btn" onClick={deposit} disabled={busy || amountWei <= 0n}>
                    {step === 'approving' ? <><Loader2 className="stake-spin" size={16} /> Approving…</>
                      : step === 'depositing' || (pendingHash && receipt.isLoading) ? <><Loader2 className="stake-spin" size={16} /> Confirming…</>
                      : 'Deposit'}
                  </button>
                  <button type="button" className="stake-btn stake-btn--secondary" onClick={withdraw} disabled={busy || !canWithdraw}>
                    {step === 'withdrawing' ? <><Loader2 className="stake-spin" size={16} /> Withdrawing…</> : 'Withdraw'}
                  </button>
                </div>
                {cooldown > 0 && <p className="stake-hint">Withdrawals unlock in {cooldownLabel(cooldown)}.</p>}
                {error && <p className="stake-error">{error}</p>}
              </div>
            )}
          </>
        )}
      </div>
      <WalletConnectModal isOpen={walletOpen} onClose={() => setWalletOpen(false)} onConnected={() => setWalletOpen(false)} />
    </div>
  );
};

/** Poll the public RPC for a receipt (approval → deposit ordering). */
async function waitFor(hash: `0x${string}`): Promise<void> {
  const { createPublicClient, http } = await import('viem');
  const client = createPublicClient({ chain: base, transport: http() });
  await client.waitForTransactionReceipt({ hash });
}

export default StakePage;
