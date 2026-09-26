import React, { useState } from 'react';
import { apiClient } from '../lib/apiClient';
import { responseError } from '../lib/responseError';

/**
 * "Find my vote": on a committed wave, fetch the bundle from Arweave in the
 * browser, check it is the committed one, and find the caller's answers in it:
 * Public answers by id in `rows`, Anon answers by the sha256 of their receipt
 * in `anon_rows` (worker/services/archive/receipts.ts). The receipt comes from
 * GET /api/me/receipts; the hashing and the lookup happen here.
 */

interface MyReceiptAnswer {
  answer_id: string;
  answer: string;
  audience: 'Public' | 'Anon';
  listed_in: 'rows' | 'anon_rows';
  receipt?: string;
}

interface Bundle {
  rows: Array<{ id: string; answer: string; handle: string | null }>;
  anon_rows?: Array<{ receipt_sha256: string; answer: string }>;
}

interface Found {
  answer_id: string;
  audience: string;
  answer: string;
  found: boolean;
  how: string;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const FindMyVote: React.FC<{ pollId: string; bundleUrl: string; bundleSha256: string }> = ({ pollId, bundleUrl, bundleSha256 }) => {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [found, setFound] = useState<Found[]>([]);
  const [bundleOk, setBundleOk] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    setState('working');
    setMessage(null);
    try {
      const res = await apiClient.get(`/api/me/receipts?poll=${encodeURIComponent(pollId)}`);
      if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to find your vote.' : await responseError(res, 'Could not load your answers'));
      const mine = await res.json() as { answers: MyReceiptAnswer[] };
      if (mine.answers.length === 0) {
        setFound([]);
        setBundleOk(null);
        setState('done');
        setMessage('You have no Public or Anon answer on this wave. (Secret answers are never in the archive.)');
        return;
      }
      const bundleRes = await fetch(bundleUrl);
      if (!bundleRes.ok) throw new Error(`The archive did not answer (${bundleRes.status}).`);
      const text = await bundleRes.text();
      setBundleOk((await sha256Hex(text)).toLowerCase() === bundleSha256.toLowerCase());
      const bundle = JSON.parse(text) as Bundle;
      const out: Found[] = [];
      for (const a of mine.answers) {
        if (a.listed_in === 'anon_rows' && a.receipt) {
          const h = await sha256Hex(a.receipt);
          const row = bundle.anon_rows?.find((r) => r.receipt_sha256 === h);
          out.push({ answer_id: a.answer_id, audience: 'Anon', answer: a.answer, found: !!row && row.answer === a.answer, how: `receipt ${h.slice(0, 10)}…` });
        } else {
          const row = bundle.rows.find((r) => r.id === a.answer_id);
          out.push({ answer_id: a.answer_id, audience: 'Public', answer: a.answer, found: !!row && row.answer === a.answer, how: row?.handle ? `as @${row.handle}` : 'by answer id' });
        }
      }
      setFound(out);
      setState('done');
    } catch (e) {
      setState('error');
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="results-meta results-find-vote">
      {state === 'idle' || state === 'error' ? (
        <button className="results-link-button" onClick={run}>Find my vote in the archive</button>
      ) : state === 'working' ? (
        <span>checking the archive…</span>
      ) : null}
      {message && <div>{message}</div>}
      {state === 'done' && found.length > 0 && (
        <div>
          {bundleOk === false
            ? <div>The bundle the archive returned does not match the committed hash.</div>
            : <div>Checked in your browser against the bundle on Arweave (it matches the committed hash):</div>}
          {found.map((f) => (
            <div key={f.answer_id}>
              {f.found ? '✓' : '✗'} {f.audience} · {f.answer} · {f.found ? `listed ${f.how}` : 'not found'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FindMyVote;
