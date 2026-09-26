import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CredentialRequest, IDKitRequestWidget, type IDKitResult, type RpContext } from '@worldcoin/idkit';
import { WorldNotice } from '../components/WorldNotice';

/**
 * Answering a World ID wave (eligibility_gate.type === 'world_id').
 *
 * `submit(answer)` asks the server for a signed rp_context, opens the IDKit
 * widget for a proof of human, then posts the answer with the proof to
 * /api/polls/:id/world-answer. An account that already answered this wave
 * (with a proof) skips the World prompt. Render `widget` somewhere in the tree.
 *
 * Errors are shown once: IDKit's modal shows its own (cancel included), and
 * ours from the server appear in a notice styled like it. Either way the
 * caller gets `shown` and adds nothing.
 */

interface WorldContext {
  app_id: `app_${string}`;
  action: string;
  environment: 'production' | 'staging' | 'sandbox';
  rp_context: RpContext;
  already_verified: boolean;
}

export type WorldAnswerOutcome =
  | { kind: 'saved'; result: Record<string, unknown> }
  | { kind: 'cancelled' }
  | { kind: 'shown' };

type ProofOutcome = { kind: 'proof'; result: IDKitResult } | { kind: 'cancelled' } | { kind: 'shown' };
type Notice = { title: string; message: string };

// IDKit reports these when the person backs out; its modal already said so.
const CANCEL_CODES = new Set(['user_rejected', 'cancelled', 'verification_rejected']);

async function serverNotice(res: Response): Promise<Notice> {
  try {
    const body = await res.json() as { error?: string; code?: string };
    if (body.code === 'world_id_used') return { title: 'Already answered', message: 'This World ID already answered this poll.' };
    if (body.code === 'poll_closed') return { title: 'Poll closed', message: 'This poll has closed.' };
    return { title: 'Not saved', message: body.error || `Request failed (${res.status})` };
  } catch {
    return { title: 'Not saved', message: `Request failed (${res.status})` };
  }
}

export function useWorldIdAnswer(pollId: string | undefined, token: string | null | undefined) {
  const [ctx, setCtx] = useState<WorldContext | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const pending = useRef<((o: ProofOutcome) => void) | null>(null);
  const lastError = useRef<string | null>(null);

  const settle = useCallback((o: ProofOutcome) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(o);
  }, []);

  const submit = useCallback(async (answer: Record<string, unknown>): Promise<WorldAnswerOutcome> => {
    if (!pollId) {
      setNotice({ title: 'Not saved', message: 'No open poll to answer.' });
      return { kind: 'shown' };
    }
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

    const ctxRes = await fetch(`/api/polls/${pollId}/world-context`, { method: 'POST', headers });
    if (!ctxRes.ok) {
      setNotice(await serverNotice(ctxRes));
      return { kind: 'shown' };
    }
    const context = await ctxRes.json() as WorldContext;

    let idkitResult: IDKitResult | undefined;
    if (!context.already_verified) {
      lastError.current = null;
      setCtx(context);
      const proof = await new Promise<ProofOutcome>(resolve => {
        pending.current = resolve;
        setOpen(true);
      });
      if (proof.kind !== 'proof') return proof;
      idkitResult = proof.result;
    }

    const res = await fetch(`/api/polls/${pollId}/world-answer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ answer, idkit_result: idkitResult }),
    });
    if (!res.ok) {
      setNotice(await serverNotice(res));
      return { kind: 'shown' };
    }
    return { kind: 'saved', result: await res.json() as Record<string, unknown> };
  }, [pollId, token]);

  const widget: ReactNode = ctx ? (
    <IDKitRequestWidget
      open={open}
      // Closing without a proof: a cancel, or an error the widget already
      // showed. onSuccess runs before the widget closes itself, so a success
      // has already settled by the time this fires.
      onOpenChange={next => {
        if (next) return;
        const code = lastError.current;
        settle(!code || CANCEL_CODES.has(code) ? { kind: 'cancelled' } : { kind: 'shown' });
      }}
      app_id={ctx.app_id}
      action={ctx.action}
      rp_context={ctx.rp_context}
      environment={ctx.environment}
      allow_legacy_proofs={false}
      constraints={CredentialRequest('proof_of_human')}
      onSuccess={result => settle({ kind: 'proof', result })}
      onError={code => { lastError.current = code; }}
    />
  ) : null;

  return {
    submit,
    widget: <>{widget}{notice && <WorldNotice {...notice} onClose={() => setNotice(null)} />}</>,
  };
}
