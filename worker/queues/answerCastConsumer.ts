/**
 * Answer-cast queue consumer.
 *
 * Producer: the public-answer write path enqueues one message per answer
 * after inserting answer_meta with pending=1 and reply_cast_hash=NULL.
 * Consumer: posts the reply cast via Hypersnap, then flips pending=0 and
 * stores reply_cast_hash once Hypersnap returns. If Hypersnap returns a
 * signer-revoked error, we mark the message failed without retry.
 *
 * See docs/hypersnap/data-layer.md § Write-path queueing.
 */

import { HypersnapError, createHypersnapService } from '../services/HypersnapService';

export interface AnswerCastMessage {
  answerId: string;
  questionId: string;
  parentCastHash: string;
  parentAuthorFid: number;
  signerUuid: string;
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
      const embeds = m.embedUrl ? [{ url: m.embedUrl }] : undefined;
      const result = await hypersnap.publishCast({
        signerUuid: m.signerUuid,
        text: m.text,
        embeds,
        parentHash: m.parentCastHash,
        parentAuthorFid: m.parentAuthorFid,
      });

      // reply_cast_hash is the authoritative commit — pending flips to 0
      // only after Hypersnap confirms the cast. The webhook fills in
      // engagement stats later; we don't block on that here.
      await env.DB.prepare(
        `UPDATE answer_meta
           SET reply_cast_hash = ?, replied_to_hash = ?, pending = 0
         WHERE id = ? AND pending = 1`,
      ).bind(result.hash, m.parentCastHash, m.answerId).run();

      msg.ack();
    } catch (err) {
      if (err instanceof HypersnapError && err.isSignerRevoked) {
        console.warn(
          `[Queue/AnswerCast] signer revoked for answer=${msg.body.answerId} — dropping without retry`,
        );
        // TODO: mark user_signers row invalid and surface reconnect prompt.
        // Not retrying: the cast cannot succeed with this signer.
        msg.ack();
        continue;
      }
      console.error(`[Queue/AnswerCast] failed answer=${msg.body.answerId}`, err);
      msg.retry();
    }
  }
}
