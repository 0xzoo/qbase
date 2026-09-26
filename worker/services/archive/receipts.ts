/**
 * Anon vote receipts: how someone who answered a wave anonymously finds
 * their answer in the committed bundle without anyone else being able to.
 *
 *   receipt         = base64url(HMAC-SHA256(ARCHIVE_RECEIPT_KEY, "qbase.receipt.v1:" + answer_id))
 *   receipt_sha256  = sha256 of the receipt string, listed in the bundle next to the answer
 *
 * The owner fetches their receipt from GET /api/me/receipts (it is derived,
 * so nothing has to be kept on a device), hashes it and finds their row.
 * Without the key a row cannot be linked to an answer id, let alone a
 * person. The worker holds the key, as it already holds the anon tag key: the
 * operator could always attribute an anon answer (SECURITY.md).
 *
 * Tradeoff, by design: a receipt lets its holder *prove* how they voted to
 * someone they choose to show it to. Public votes are provable already.
 *
 * The key must outlive every bundle it was used for: receipts for committed
 * waves are only recomputable with the same key. Losing it loses the owner
 * lookup, never the bundle.
 */

import { sha256Hex } from './canonicalJson';

export const RECEIPT_DOMAIN = 'qbase.receipt.v1:';

export interface ReceiptEnv { ARCHIVE_RECEIPT_KEY?: string }

export class ReceiptKeyMissing extends Error {
  constructor() { super('ARCHIVE_RECEIPT_KEY is not set: anon rows cannot be committed without receipts'); }
}

function keyBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

export function hasReceiptKey(env: ReceiptEnv): boolean {
  return !!env.ARCHIVE_RECEIPT_KEY;
}

export async function receiptFor(env: ReceiptEnv, answerId: string): Promise<string> {
  if (!env.ARCHIVE_RECEIPT_KEY) throw new ReceiptKeyMissing();
  const key = await crypto.subtle.importKey('raw', keyBytes(env.ARCHIVE_RECEIPT_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(RECEIPT_DOMAIN + answerId)));
  let s = '';
  for (const b of mac) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function receiptHash(receipt: string): Promise<`0x${string}`> {
  return sha256Hex(receipt);
}
