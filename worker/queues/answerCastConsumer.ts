/**
 * Answer-cast queue consumer.
 *
 * Producer: the public-answer write path enqueues one message per answer
 * after inserting answer_meta with pending=1 and reply_cast_hash=NULL.
 * Consumer: posts the reply cast to the Farcaster hub via @farcaster/core
 * signing, then flips pending=0 and stores reply_cast_hash.
 *
 * Bot signers:
 *   - 4n0n (FID 514282): ANON_SIGNER_KEY — anon/public answers
 *   - Q    (FID 975961): QGENT_SIGNER_KEY — agent replies + share-bot
 *
 * See docs/hypersnap/data-layer.md § Write-path queueing.
 */

import { HypersnapError, createHypersnapService } from '../services/HypersnapService';

export interface AnswerCastMessage {
  answerId: string;
  questionId: string;
  parentCastHash: string;
  parentAuthorFid: number;
  /** Which bot signs the cast: 'anon' (4n0n) or 'q' (Q) */
  signer: 'anon' | 'q';
  text: string;
  embedUrl?: string;
}

type Env = any;

export async function handleAnswerCastBatch(
  batch: MessageBatch<AnswerCastMessage>,
  env: Env,
): Promise<void> {
  const hypersnap = createHypersnapService(env);

  for (const msg of batch.messages) {
    try {
      const m = msg.body;
      const { signerKey, fid } = resolveSigner(m.signer, env);
      const embeds = m.embedUrl ? [{ url: m.embedUrl }] : undefined;

      const result = await hypersnap.publishCast({
        signerKey,
        fid,
        text: m.text,
        embeds,
        parentHash: m.parentCastHash,
        parentAuthorFid: m.parentAuthorFid,
      });

      // reply_cast_hash is the authoritative commit — pending flips to 0
      // only after the hub confirms the cast.
      await env.DB.prepare(
        `UPDATE answer_meta
           SET reply_cast_hash = ?, replied_to_hash = ?, pending = 0
         WHERE id = ? AND pending = 1`,
      ).bind(result.hash, m.parentCastHash, m.answerId).run();

      msg.ack();
    } catch (err) {
      if (err instanceof HypersnapError && err.isSignerRevoked) {
        console.warn(
          `[Queue/AnswerCast] signer invalid/revoked for answer=${msg.body.answerId} — dropping without retry`,
        );
        msg.ack();
        continue;
      }
      console.error(`[Queue/AnswerCast] failed answer=${msg.body.answerId}`, err);
      msg.retry();
    }
  }
}

function resolveSigner(signer: 'anon' | 'q', env: Env): { signerKey: string; fid: number } {
  if (signer === 'anon') {
    const key = env.ANON_SIGNER_KEY;
    if (!key) throw new Error('ANON_SIGNER_KEY not configured');
    return { signerKey: key, fid: Number(env.ANON_FID ?? 514282) };
  }
  const key = env.QGENT_SIGNER_KEY;
  if (!key) throw new Error('QGENT_SIGNER_KEY not configured');
  return { signerKey: key, fid: Number(env.QGENT_FID ?? 975961) };
}
