import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CredentialRequest, IDKitRequestWidget, type IDKitErrorCodes, type IDKitResult, type RpContext } from '@worldcoin/idkit';

/**
 * Answering a World ID wave (eligibility_gate.type === 'world_id').
 *
 * `submit(answer)` asks the server for a signed rp_context, opens the IDKit
 * widget for a proof of human, then posts the answer with the proof to
 * /api/polls/:id/world-answer. An account that already answered this wave
 * (with a proof) skips the World prompt. Render `widget` somewhere in the tree.
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
  | { kind: 'error'; message: string };

type ProofOutcome = { kind: 'proof'; result: IDKitResult } | Exclude<WorldAnswerOutcome, { kind: 'saved' }>;

const CREDENTIAL_HELP =
  'This wave needs a World ID proof of human, which you get by verifying at an Orb. Find one in World App or at world.org/find-orb.';

function proofErrorMessage(code: IDKitErrorCodes | string): string {
  switch (code) {
    case 'credential_unavailable':
    case 'world_id_4_not_available':
      return CREDENTIAL_HELP;
    case 'max_verifications_reached':
    case 'nullifier_replayed':
      return 'This World ID already answered this wave.';
    case 'rp_signature_expired':
    case 'timestamp_too_old':
      return 'The verification request expired. Try again.';
    default:
      return `World ID verification failed (${code}).`;
  }
}

async function serverError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string; code?: string };
    if (body.code === 'world_id_used') return 'This World ID already answered this wave.';
    if (body.code === 'poll_closed') return 'This wave has closed.';
    return body.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function useWorldIdAnswer(pollId: string | undefined, token: string | null | undefined) {
  const [ctx, setCtx] = useState<WorldContext | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<((o: ProofOutcome) => void) | null>(null);
  const lastError = useRef<string | null>(null);

  const settle = useCallback((o: ProofOutcome) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(o);
  }, []);

  const submit = useCallback(async (answer: Record<string, unknown>): Promise<WorldAnswerOutcome> => {
    if (!pollId) return { kind: 'error', message: 'No open wave to answer' };
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

    const ctxRes = await fetch(`/api/polls/${pollId}/world-context`, { method: 'POST', headers });
    if (!ctxRes.ok) return { kind: 'error', message: await serverError(ctxRes) };
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
    if (!res.ok) return { kind: 'error', message: await serverError(res) };
    return { kind: 'saved', result: await res.json() as Record<string, unknown> };
  }, [pollId, token]);

  const widget: ReactNode = ctx ? (
    <IDKitRequestWidget
      open={open}
      // Closing without a proof: the error the widget showed, or a cancel.
      // onSuccess runs before the widget closes itself, so a success has
      // already settled by the time this fires.
      onOpenChange={next => {
        if (next) return;
        const code = lastError.current;
        settle(code && code !== 'user_rejected' && code !== 'cancelled'
          ? { kind: 'error', message: proofErrorMessage(code) }
          : { kind: 'cancelled' });
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

  return { submit, widget };
}
