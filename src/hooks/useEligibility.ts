import { useEffect, useState } from 'react';
import type { Query } from '../lib/types';

/**
 * Eligibility state for a poll. Two gates can apply: `closes_at` (time)
 * and `eligibility_gate` (who). Legacy non-poll questions skip the network
 * call and return immediately as fully eligible.
 *
 * The server-side resolved FID list is intentionally never shipped to the
 * client — we hit `/api/queries/:id/eligibility?fid=` so a poll with a
 * 50k-FID gate doesn't bloat the page payload.
 */

export type EligibilityReason = 'no_gate' | 'open' | 'closed' | 'not_holder' | 'unknown_gate';

export interface EligibilityState {
  /** Whether the viewer is allowed to submit an answer right now. */
  canVote: boolean;
  /** Why — drives the lock-banner copy. */
  reason: EligibilityReason;
  /** Echoed back from server when set on the query, for countdown display. */
  closesAt?: string;
  /** True while the network probe is in flight. UI should not flash a wrong state. */
  isLoading: boolean;
}

const NO_GATE: EligibilityState = { canVote: true, reason: 'no_gate', isLoading: false };

export function useEligibility(question: Query | null | undefined, viewerFid: number | undefined): EligibilityState {
  const hasGate = Boolean(question?.closes_at || question?.eligibility_gate);
  const [state, setState] = useState<EligibilityState>(hasGate ? { canVote: false, reason: 'no_gate', isLoading: true } : NO_GATE);

  useEffect(() => {
    if (!question?.id || !hasGate) {
      setState(NO_GATE);
      return;
    }
    // Without a viewer FID we can only enforce the time gate locally.
    // Eligibility-gate locks resolve to "not_holder" so the viewer sees
    // a sensible locked state until they connect.
    if (!viewerFid) {
      const closedByTime = question.closes_at && Date.parse(question.closes_at) <= Date.now();
      if (closedByTime) {
        setState({ canVote: false, reason: 'closed', closesAt: question.closes_at, isLoading: false });
      } else if (question.eligibility_gate) {
        setState({ canVote: false, reason: 'not_holder', closesAt: question.closes_at, isLoading: false });
      } else {
        setState({ canVote: true, reason: 'open', closesAt: question.closes_at, isLoading: false });
      }
      return;
    }

    let cancelled = false;
    setState(s => ({ ...s, isLoading: true }));

    (async () => {
      try {
        const res = await fetch(`/api/queries/${question.id}/eligibility?fid=${viewerFid}`);
        if (!res.ok) throw new Error(`eligibility probe failed: ${res.status}`);
        const data = (await res.json()) as { eligible: boolean; reason: EligibilityReason; closesAt?: string };
        if (cancelled) return;
        setState({
          canVote: data.eligible,
          reason: data.reason,
          closesAt: data.closesAt,
          isLoading: false,
        });
      } catch (err) {
        console.error('[useEligibility]', err);
        if (cancelled) return;
        // Fail-open on probe error: better to let the server reject the
        // submission than to lock out a legitimately eligible viewer
        // because a single network call hiccupped.
        setState({ canVote: true, reason: 'open', closesAt: question.closes_at, isLoading: false });
      }
    })();

    return () => { cancelled = true; };
  }, [question?.id, hasGate, question?.closes_at, question?.eligibility_gate, viewerFid]);

  return state;
}
