/**
 * /ca-slate/result — mini-app result page for the CA slate quiz.
 *
 * Loads the session via /api/ca-slate/session?sid=X (auth required) and renders
 * 8 office cards stacked: top match, party, alignment %, 1-line reason.
 * No airdrop, no $QQ gate, no LLM narrative — pure algorithmic result.
 *
 * Data sourcing footer at the bottom — Type C transparency rule.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle } from 'lucide-react';
import Header from '../components/Header';
import './CASlateResult.css';

type PartyChoice = 'dem' | 'rep' | 'any';
type Party = 'D' | 'R' | 'G' | 'P&F' | 'NPP';

interface OfficeMatch {
  name: string;
  topCandidate: string;
  topParty: Party;
  topAlignment: number;
  topDistance: number;
  topReason: string;
  allRanked: Array<{
    name: string;
    party: Party;
    distance: number;
    alignment: number;
  }>;
}

interface CaSlateResult {
  userProfile: number[];
  partyChoice: PartyChoice;
  offices: OfficeMatch[];
  totalAnswered: number;
  totalExpected: number;
}

interface SessionInfo {
  id: string;
  fid: number;
  index: number;
  total: number;
  completed: boolean;
  createdAt: number;
}

type Phase = 'loading' | 'incomplete' | 'result' | 'error';

const PARTY_FULL: Record<Party, string> = {
  D: 'Democrat',
  R: 'Republican',
  G: 'Green',
  'P&F': 'Peace & Freedom',
  NPP: 'Nonpartisan',
};

const PARTY_FILTER_LABEL: Record<PartyChoice, string> = {
  dem: 'democratic primary',
  rep: 'republican primary',
  any: 'any party',
};

// 13 axes — labels match questions.ts.
const AXIS_LABEL = [
  'housing',
  'tax',
  'crime',
  'climate',
  'education',
  'healthcare',
  'immigration',
  'limited government',
  'DEI',
  'fiscal oversight',
  'election integrity',
  'consumer protection',
  'AIPAC funding',
] as const;

function formatPct(alignment: number): string {
  return `${Math.round(alignment * 100)}%`;
}

const CASlateResult: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [result, setResult] = useState<CaSlateResult | null>(null);

  const loadSession = useCallback(async () => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }
    try {
      setPhase('loading');
      const res = await sdk.quickAuth.fetch(
        `/api/ca-slate/session?sid=${encodeURIComponent(sid)}`,
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        session: SessionInfo;
        result: CaSlateResult | null;
      };
      setSession(body.session);
      if (body.session.completed && body.result) {
        setResult(body.result);
        setPhase('result');
      } else {
        setPhase('incomplete');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session');
      setPhase('error');
    }
  }, [sid]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const handleShare = useCallback(async () => {
    if (!result || !session) return;
    const shareUrl = `${window.location.origin}/snap/ca-slate?share&sid=${encodeURIComponent(session.id)}`;
    try {
      await sdk.actions.composeCast({
        text: 'just took the ca slate quiz on @qbase — my picks across 8 ca offices',
        embeds: [shareUrl],
      });
    } catch {
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        /* silent */
      }
    }
  }, [result, session]);

  if (phase === 'loading') {
    return (
      <>
        <Header title="ca slate" />
        <div className="caslate-result caslate-result--center">
          <Loader2 className="caslate-spin" size={32} />
          <p>loading your slate…</p>
        </div>
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        <Header title="ca slate" />
        <div className="caslate-result caslate-result--center">
          <AlertCircle size={32} />
          <p>{error || 'something went wrong'}</p>
        </div>
      </>
    );
  }

  if (phase === 'incomplete' && session) {
    const remaining = session.total - session.index;
    return (
      <>
        <Header title="ca slate" />
        <div className="caslate-result caslate-result--center">
          <h2>quiz in progress</h2>
          <p>
            you've answered {session.index} of {session.total} — {remaining} to go.
          </p>
          <a
            className="caslate-btn caslate-btn--primary"
            href={`/snap/ca-slate?sid=${encodeURIComponent(session.id)}`}
          >
            continue
          </a>
        </div>
      </>
    );
  }

  if (!result) return null;

  return (
    <>
      <Header title="ca slate" />
      <div className="caslate-result">
        <header className="caslate-header">
          <div className="caslate-badge">
            {PARTY_FILTER_LABEL[result.partyChoice].toUpperCase()}
          </div>
          <p className="caslate-tagline">
            your picks across 8 california statewide offices
          </p>
        </header>

        <section className="caslate-offices">
          {result.offices.map((office) => (
            <OfficeCard key={office.name} office={office} />
          ))}
        </section>

        <section className="caslate-actions">
          <button
            className="caslate-btn caslate-btn--primary"
            onClick={handleShare}
          >
            share
          </button>
        </section>

        <UserProfilePanel profile={result.userProfile} />

        <footer className="caslate-sourcing">
          <h4>how this was scored</h4>
          <p>
            candidate scores reflect public positions sourced from calmatters,
            ballotpedia, the ca secretary of state voter guide, oc register,
            kpbs, campaign websites, and news reporting. candidates with no
            public platform on a given dimension are scored 0.5 (neutral) —
            they won't match strongly on any profile. this is a personal
            alignment tool, not an endorsement. verify with your own research
            before voting.
          </p>
          <p className="caslate-sourcing-method">
            per-office scoring uses only the policy dimensions relevant to that
            office (e.g. treasurer dims are housing/tax/lim-gov/fiscal/climate/
            dei/immigration/aipac — not crime). alignment % is 1 minus the
            normalized euclidean distance on that subset.
          </p>
        </footer>
      </div>
    </>
  );
};

const OfficeCard: React.FC<{ office: OfficeMatch }> = ({ office }) => {
  const alignmentPct = formatPct(office.topAlignment);
  const hasStrongMatch = office.topAlignment >= 0.7;
  return (
    <article className="caslate-office-card">
      <div className="caslate-office-head">
        <h3>{office.name}</h3>
        <span className="caslate-office-pct">{alignmentPct}</span>
      </div>
      <div className="caslate-office-top">
        <span className="caslate-office-name">{office.topCandidate}</span>
        <span className={`caslate-office-party caslate-party-${office.topParty}`}>
          {PARTY_FULL[office.topParty]}
        </span>
      </div>
      <p className="caslate-office-reason">{office.topReason}</p>
      {!hasStrongMatch && (
        <p className="caslate-office-weak">
          no strong match — your positions don't line up cleanly with this
          office's field
        </p>
      )}
      {office.allRanked.length > 1 && (
        <details className="caslate-office-details">
          <summary>see all {office.allRanked.length} candidates</summary>
          <ul>
            {office.allRanked.map((c) => (
              <li key={c.name}>
                <span className="caslate-office-rank-name">{c.name}</span>
                <span className={`caslate-office-rank-party caslate-party-${c.party}`}>
                  {c.party}
                </span>
                <span className="caslate-office-rank-pct">
                  {formatPct(c.alignment)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
};

// Compact 13-dim profile view — context for the user, helps them see how
// their answers mapped. Linear bar list, no chart, low visual cost.
const UserProfilePanel: React.FC<{ profile: number[] }> = ({ profile }) => {
  return (
    <section className="caslate-profile">
      <h3>your 13-dim profile</h3>
      <p className="caslate-profile-tagline">
        0 = strongly disagree, 1 = strongly agree with the question stem
      </p>
      <ul className="caslate-profile-list">
        {profile.map((v, i) => (
          <li key={AXIS_LABEL[i]}>
            <span className="caslate-profile-axis">{AXIS_LABEL[i]}</span>
            <span className="caslate-profile-bar">
              <span
                className="caslate-profile-bar-fill"
                style={{ width: `${v * 100}%` }}
              />
            </span>
            <span className="caslate-profile-value">{v.toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default CASlateResult;
