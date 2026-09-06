import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import './QuestionResultsPage.css';

interface DistributionRow {
  label: string;
  count: number;
  pct: number;
}

interface RecentAnswer {
  value: string;
  author: string;
  created_at: string | null;
}

interface AggregateResults {
  question: {
    id: string;
    stem: string;
    type: string;
    options: string[];
    created_at: string | null;
    coiner_fname: string | null;
    coiner_fid: number | null;
    /** 'request' = a Q&A thread, not a tally */
    intent?: 'measure' | 'request' | null;
  };
  total: number;
  distribution: DistributionRow[];
  recent: RecentAnswer[];
}

const QuestionResultsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AggregateResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [animateIn, setAnimateIn] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/queries/${id}/aggregate`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Question not found' : 'Failed to load results');
        return res.json() as Promise<AggregateResults>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
        // let bars mount at width 0, then transition to their real width
        requestAnimationFrame(() => requestAnimationFrame(() => setAnimateIn(true)));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  const resultsUrl = `${window.location.origin}/question/${id}/results`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resultsUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const castUrl = data
    ? `https://farcaster.xyz/~/compose?text=${encodeURIComponent(data.question.stem)}&embeds[]=${encodeURIComponent(resultsUrl)}`
    : '#';

  const winnerCount = data
    ? data.distribution.reduce((max, row) => Math.max(max, row.count), 0)
    : 0;

  return (
    <div className="results-page-wrapper">
      <Header
        showBack
        backLabel="Question"
        onBack={() => navigate(`/question/${id}`)}
      />
      <div className="results-page mobile-layout-container">
        {loading && (
          <div className="results-loading">
            <LoadingAnimation variant="spinner" size="lg" />
          </div>
        )}

        {!loading && error && (
          <div className="results-error">{error}</div>
        )}

        {!loading && data && (
          <div className="results-card">
            <h1 className="results-stem">{data.question.stem}</h1>
            <div className="results-meta">
              {data.question.intent === 'request' && <>thread · </>}
              {data.total === 1 ? '1 answer' : `${data.total} answers`}
              {data.question.coiner_fname && (
                <> · asked by <span className="results-coiner">@{data.question.coiner_fname}</span></>
              )}
            </div>

            {data.distribution.length > 0 && (
              <div className="results-bars">
                {data.distribution.map((row) => {
                  const isWinner = row.count === winnerCount && row.count > 0;
                  return (
                    <div className="results-bar-row" key={row.label}>
                      <div className="results-bar-labels">
                        <span className="results-bar-label">{row.label}</span>
                        <span className={`results-bar-pct${isWinner ? ' winner' : ''}`}>
                          {row.pct}% · {row.count}
                        </span>
                      </div>
                      <div className="results-bar-track">
                        <div
                          className={`results-bar-fill${isWinner ? ' winner' : ''}`}
                          style={{ width: animateIn ? `${Math.max(row.pct, row.count > 0 ? 2 : 0)}%` : '0%' }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {data.distribution.length === 0 && data.recent.length > 0 && (
              <div className="results-recent">
                {data.recent.map((answer, i) => (
                  <div className="results-recent-row" key={i}>
                    <span className="results-recent-author">@{answer.author}</span>
                    <span className="results-recent-value">{answer.value}</span>
                  </div>
                ))}
              </div>
            )}

            {data.total === 0 && (
              <div className="results-empty">No answers yet — be the first.</div>
            )}

            <div className="results-actions">
              <button
                className="results-action primary"
                onClick={() => navigate(`/question/${id}`)}
              >
                Answer this question
              </button>
              <a
                className="results-action"
                href={castUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Cast results
              </a>
              <button className="results-action" onClick={handleCopy}>
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default QuestionResultsPage;
