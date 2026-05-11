import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle, Copy, Check, ExternalLink } from 'lucide-react';
import Header from '../components/Header';
import './ValuesExport.css';

type Phase = 'loading' | 'ready' | 'error';

const ValuesExport: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }
    (async () => {
      try {
        const res = await sdk.quickAuth.fetch(
          `/api/values/export?sid=${encodeURIComponent(sid)}`,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const text = await res.text();
        setMarkdown(text);
        setPhase('ready');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load export');
        setPhase('error');
      }
    })();
  }, [sid]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('copy failed — your browser may not support clipboard access');
    }
  }, [markdown]);

  const handleOpenExternal = useCallback(async () => {
    if (!sid) return;
    const url = `${window.location.origin}/api/values/export?sid=${encodeURIComponent(sid)}`;
    try {
      await sdk.actions.openUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }, [sid]);

  return (
    <>
      <Header title="context card" showBack />
      <div className="values-export">
        {phase === 'loading' && (
          <div className="values-export--center">
            <Loader2 className="values-export-spin" size={32} />
            <p>loading your context card…</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="values-export--center">
            <AlertCircle size={32} />
            <p>{error || 'something went wrong'}</p>
          </div>
        )}

        {phase === 'ready' && (
          <>
            <p className="values-export-blurb">
              drop this into an LLM context window or your own profile server.
            </p>
            <div className="values-export-actions">
              <button
                className="values-export-btn values-export-btn--primary"
                onClick={handleCopy}
              >
                {copied ? (
                  <>
                    <Check size={14} /> copied
                  </>
                ) : (
                  <>
                    <Copy size={14} /> copy all
                  </>
                )}
              </button>
              <button
                className="values-export-btn values-export-btn--secondary"
                onClick={handleOpenExternal}
              >
                <ExternalLink size={14} /> open in browser
              </button>
            </div>
            <pre className="values-export-md">{markdown}</pre>
          </>
        )}
      </div>
    </>
  );
};

export default ValuesExport;
