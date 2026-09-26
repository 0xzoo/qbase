import React from 'react';
import type { Query } from '../lib/types';
import type { EligibilityReason } from '../hooks/useEligibility';

interface PollLockBannerProps {
  reason: EligibilityReason;
  question: Query;
  closesAt?: string;
}

/**
 * Inline banner explaining why a viewer can't vote through a wave. Shown
 * above the disabled `QuestionRenderer`. Reads the gate from the question's
 * current wave (`question.current_poll`). Three states matter:
 *   - closed: the wave's `closes_at` has passed
 *   - not_holder: viewer is missing from the NFT snapshot
 *   - unknown_gate: defensive — server responded with a gate type we don't
 *                   render. Should not happen in v0.
 */
const PollLockBanner: React.FC<PollLockBannerProps> = ({ reason, question, closesAt }) => {
  const message = buildMessage(reason, question, closesAt);
  if (!message) return null;
  return (
    <div className="poll-lock-banner" role="status">
      <span className="poll-lock-banner__icon" aria-hidden>🔒</span>
      <span className="poll-lock-banner__text">{message}</span>
    </div>
  );
};

function buildMessage(reason: EligibilityReason, question: Query, closesAt?: string): string | null {
  if (reason === 'closed') {
    if (closesAt) {
      const when = new Date(closesAt).toLocaleString();
      return `Voting closed ${when}`;
    }
    return 'Voting has closed';
  }
  if (reason === 'not_holder') {
    const gate = question.current_poll?.eligibility_gate;
    if (gate?.type === 'nft_snapshot') {
      const short = `${gate.contract.slice(0, 6)}…${gate.contract.slice(-4)}`;
      return `Holders of ${short} only`;
    }
    if (gate?.type === 'token_snapshot') {
      const amount = formatThreshold(gate.min_balance);
      const tokenLabel = gate.symbol
        ? `$${gate.symbol}`
        : `${gate.contract.slice(0, 6)}…${gate.contract.slice(-4)}`;
      return `Hold ≥ ${amount} ${tokenLabel} to vote`;
    }
    return 'You are not eligible to vote on this poll';
  }
  if (reason === 'not_verified') {
    return 'Verified humans only: saving your answer asks for a World ID proof, once per wave';
  }
  if (reason === 'unknown_gate') {
    return 'This poll has an eligibility gate this client does not understand';
  }
  return null;
}

function formatThreshold(raw: string): string {
  // Accepts "4420000" or "4420000.5"; returns "4,420,000" / "4,420,000.5".
  // Keeps the user's exact value (no rounding) so the gate copy matches what
  // they typed at creation.
  const [whole, frac] = raw.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

export default PollLockBanner;
