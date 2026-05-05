import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import LoadingAnimation from '../components/LoadingAnimation';

type LookupResult =
  | { match: 'question'; questionId: string; anchor?: 'historical' }
  | { match: 'answer'; answerId: string; questionId: string }
  | { match: 'none' };

type SharedCast = {
  hash: string;
  text?: string;
  author?: { fid: number; username?: string; displayName?: string; pfpUrl?: string };
  channelKey?: string;
};

const SharePage: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [missCast, setMissCast] = useState<SharedCast | null>(null);
  const [error, setError] = useState<string | null>(null);

  const castHash = (params.get('castHash') || '').trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;

    if (!castHash) {
      setError('missing cast hash');
      return;
    }

    (async () => {
      // Pull SDK context in parallel — used only to enrich the miss UI.
      const ctxPromise = (async () => {
        try {
          const ctx = await sdk.context;
          if (ctx?.location?.type === 'cast_share') {
            const c = ctx.location.cast;
            return {
              hash: c.hash,
              text: c.text,
              author: c.author
                ? {
                    fid: c.author.fid,
                    username: c.author.username,
                    displayName: c.author.displayName,
                    pfpUrl: c.author.pfpUrl,
                  }
                : undefined,
              channelKey: c.channelKey,
            } as SharedCast;
          }
        } catch {
          /* not in miniapp / no context — fine */
        }
        return null;
      })();

      try {
        const res = await fetch(
          `/api/farcaster/share-lookup?castHash=${encodeURIComponent(castHash)}`
        );
        if (!res.ok) throw new Error(`lookup failed: ${res.status}`);
        const data = (await res.json()) as LookupResult;
        if (cancelled) return;

        if (data.match === 'question') {
          navigate(`/question/${data.questionId}`, { replace: true });
          return;
        }
        if (data.match === 'answer') {
          navigate(`/answer/${data.answerId}`, { replace: true });
          return;
        }

        // Miss → render fallback UI, enriched with SDK cast if available.
        const enriched = await ctxPromise;
        if (cancelled) return;
        setMissCast(enriched ?? { hash: castHash });
      } catch (e) {
        if (cancelled) return;
        console.error('[Share] lookup error', e);
        setError('something went wrong');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [castHash, navigate]);

  if (error) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ marginBottom: 16 }}>{error}</p>
          <button style={primaryBtn} onClick={() => navigate('/questions')}>
            go to qbase
          </button>
        </div>
      </div>
    );
  }

  if (!missCast) {
    return <LoadingAnimation />;
  }

  // Miss UI: cast not in qbase. Soft offramp — link to feed, no auto-prefill
  // of a new question (intentionally avoiding double-embed weirdness in the
  // Farcaster client when a question with both a snap and a quoted cast renders).
  const author = missCast.author;
  const handle = author?.username ? `@${author.username}` : `fid ${author?.fid ?? '?'}`;

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>not in qbase yet</h1>
        <p style={{ opacity: 0.75, marginBottom: 16, fontSize: 14 }}>
          this cast isn't a qbase question or answer.
        </p>

        {missCast.text && (
          <blockquote style={quoteStyle}>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>{handle}</div>
            <div style={{ fontSize: 14 }}>{missCast.text}</div>
          </blockquote>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button style={primaryBtn} onClick={() => navigate('/questions')}>
            ask on qbase
          </button>
          <button style={secondaryBtn} onClick={() => navigate('/')}>
            home
          </button>
        </div>
      </div>
    </div>
  );
};

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: '#0a0d14',
  color: '#fff',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 480,
  padding: 24,
  borderRadius: 12,
  background: '#11151f',
  border: '1px solid rgba(255,255,255,0.08)',
};

const quoteStyle: React.CSSProperties = {
  margin: 0,
  padding: 12,
  borderLeft: '3px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.03)',
  borderRadius: 4,
};

const primaryBtn: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 8,
  background: '#fff',
  color: '#0a0d14',
  border: 'none',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 8,
  background: 'transparent',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.2)',
  cursor: 'pointer',
};

export default SharePage;
