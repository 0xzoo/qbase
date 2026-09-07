import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Poll, Query } from '../lib/types';

/**
 * The question's waves: the one in play (open, or the one named by ?poll=)
 * and every past wave with a link to its results. A question is answerable
 * forever; a wave is a time-bounded sampling frame over it.
 */
const WaveStrip: React.FC<{ question: Query }> = ({ question }) => {
  const current = question.current_poll;
  const [waves, setWaves] = useState<Poll[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || waves) return;
    let cancelled = false;
    fetch(`/api/queries/${question.id}/polls`)
      .then(r => (r.ok ? r.json() : { polls: [] }))
      .then((json: { polls?: Poll[] }) => { if (!cancelled) setWaves(json.polls ?? []); })
      .catch(() => { if (!cancelled) setWaves([]); });
    return () => { cancelled = true; };
  }, [expanded, waves, question.id]);

  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="wave-strip" style={{ fontSize: 13, color: 'var(--qbase-text-muted, #64748b)', margin: '6px 0 10px', display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center' }}>
      {current ? (
        <span>
          {current.is_closed ? `poll closed ${fmt(current.closes_at)}` : `poll closes ${fmt(current.closes_at)}`}
          {' · '}
          <Link to={`/poll/${current.id}/results`}>results</Link>
        </span>
      ) : (
        <span>open question</span>
      )}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
      >
        {expanded ? 'hide polls' : 'all polls'}
      </button>
      <Link to={`/create-poll?question=${question.id}`}>ask again as a new poll</Link>
      {expanded && (
        <ul style={{ width: '100%', margin: 0, paddingLeft: 18 }}>
          {waves === null && <li>loading…</li>}
          {waves && waves.length === 0 && <li>no polls yet</li>}
          {waves?.map(w => (
            <li key={w.id}>
              {w.is_closed ? `closed ${fmt(w.closes_at)}` : `closes ${fmt(w.closes_at)}`}
              {w.eligibility_gate ? ' · holders only' : ''}
              {' · '}
              <Link to={`/poll/${w.id}/results`}>results</Link>
              {!w.is_closed && w.id !== current?.id && (
                <> · <Link to={`/question/${question.id}?poll=${w.id}`}>answer</Link></>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default WaveStrip;
