import { useEffect, useState } from 'react';
import type { Query } from '../lib/types';

/**
 * Eligibility state for answering through a wave. Gates live on waves only
 * (`question.current_poll`): a question with no wave in play is always
 * answerable and skips the network call entirely.
 *
 * The server-side resolved FID list is intentionally never shipped to the
 * client — we hit `/api/polls/:id/eligibility?fid=` so a wave with a
 * 50k-FID gate doesn't bloat the page payload.
 */

export type EligibilityReason = 'no_gate' | 'open' | 'closed' | 'not_holder' | 'not_verified' | 'unknown_gate';

export interface EligibilityState {
  /** Whether the viewer is allowed to submit an answer right now. */
  canVote: boolean;
  /** Why — drives the lock-banner copy. */
  reason: EligibilityReason;
  /** The wave's close time, for countdown display. */
  closesAt?: string;
  /** The wave the verdict applies to. */
  pollId?: string;
  /** True while the network probe is in flight. UI should not flash a wrong state. */
  isLoading: boolean;
  /**
   * World ID wave: anyone signed in may answer, and saving asks for a proof
   * (useWorldIdAnswer). There is no probe: the public probe cannot tell
   * whether this account already answered, by design.
   */
  worldGated?: boolean;
}

const NO_GATE: EligibilityState = { canVote: true, reason: 'no_gate', isLoading: false };

/**
 * `viewerFid` is the viewer's linked Farcaster fid (snapshot gates list fids);
 * `signedIn` is whether they hold any account at all, which is all a world_id
 * wave needs: the proof is asked for on save, whatever the login.
 */
export function useEligibility(
  question: Query | null | undefined,
  viewerFid: number | undefined,
  signedIn: boolean = Boolean(viewerFid),
): EligibilityState {
  const poll = question?.current_poll;
  const pollId = poll?.id;
  const closesAt = poll?.closes_at;
  const hasHolderGate = Boolean(poll?.eligibility_gate);
  const worldGated = poll?.eligibility_gate?.type === 'world_id';
  const [state, setState] = useState<EligibilityState>(
    pollId ? { canVote: false, reason: 'no_gate', closesAt, pollId, isLoading: true } : NO_GATE,
  );

  useEffect(() => {
    if (!pollId) {
      setState(NO_GATE);
      return;
    }
    // The time gate is local knowledge; holder gates need the server.
    const closedByTime = Boolean(closesAt && Date.parse(closesAt) <= Date.now());
    if (closedByTime) {
      setState({ canVote: false, reason: 'closed', closesAt, pollId, isLoading: false });
      return;
    }
    if (!hasHolderGate) {
      setState({ canVote: true, reason: 'no_gate', closesAt, pollId, isLoading: false });
      return;
    }
    if (worldGated) {
      setState({ canVote: signedIn, reason: 'not_verified', closesAt, pollId, isLoading: false, worldGated: true });
      return;
    }
    // Without a viewer FID a holder gate resolves to "not_holder" so the
    // viewer sees a sensible locked state until they connect.
    if (!viewerFid) {
      setState({ canVote: false, reason: 'not_holder', closesAt, pollId, isLoading: false });
      return;
    }

    let cancelled = false;
    setState(s => ({ ...s, isLoading: true }));

    (async () => {
      try {
        const res = await fetch(`/api/polls/${pollId}/eligibility?fid=${viewerFid}`);
        if (!res.ok) throw new Error(`eligibility probe failed: ${res.status}`);
        const data = (await res.json()) as { eligible: boolean; reason: EligibilityReason; closesAt?: string };
        if (cancelled) return;
        setState({
          canVote: data.eligible,
          reason: data.reason,
          closesAt: data.closesAt ?? closesAt,
          pollId,
          isLoading: false,
        });
      } catch (err) {
        console.error('[useEligibility]', err);
        if (cancelled) return;
        // Fail-open on probe error: better to let the server reject the
        // submission than to lock out a legitimately eligible viewer
        // because a single network call hiccupped.
        setState({ canVote: true, reason: 'open', closesAt, pollId, isLoading: false });
      }
    })();

    return () => { cancelled = true; };
  }, [pollId, closesAt, hasHolderGate, worldGated, viewerFid, signedIn]);

  return state;
}
