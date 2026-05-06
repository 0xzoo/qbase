import React from 'react';
import type { Query } from '../lib/types';
import type { EligibilityReason } from '../hooks/useEligibility';

interface PollLockBannerProps {
  reason: EligibilityReason;
  question: Query;
  closesAt?: string;
}

/**
 * Inline banner explaining why a viewer can't vote on a poll. Shown above
 * the disabled `QuestionRenderer`. Three states matter:
 *   - closed: the poll's `closes_at` has passed
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
    const gate = question.eligibility_gate;
    if (gate?.type === 'nft_snapshot') {
      const short = `${gate.contract.slice(0, 6)}…${gate.contract.slice(-4)}`;
      return `Holders of ${short} only`;
    }
    return 'You are not eligible to vote on this poll';
  }
  if (reason === 'unknown_gate') {
    return 'This poll has an eligibility gate this client does not understand';
  }
  return null;
}

export default PollLockBanner;
