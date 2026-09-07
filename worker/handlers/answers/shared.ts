import { SecretStore } from '../../services/secret/SecretStore';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Env = any;

export interface AnswerRequest {
  q_id: string;
  user_id: number; // Injected by worker from auth token
  value: string;   // Plain display text of the answer
  answer_type_id: number; // FK to answer_types: 1=text, 2=mc, 3=scale, 4=checkbox
  answer_data?: Record<string, unknown>; // Type-specific structured data
  audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
  /** Wave this answer is cast through. Omit for a direct answer to the question. */
  poll_id?: string;
  allowlist_id?: string; // Reference to named allowlist
  allowlist?: number[]; // One-off FID array
  // Knowledge-question fields (optional)
  reasoning?: string; // Justification for knowledge answers
  topics?: string[]; // Domain tags for knowledge answers
}

/**
 * Never let an Anon row name its author on the wire.
 *
 * Anon answers written in-feed carry the responder's real FID in
 * `Answers.user_id` (the snap needs it for one-vote-per-person), while the
 * `audience` tag is the masking signal. Every read path that spreads a row
 * or joins `users` must pass through here. `is_own_anon` (set only for the
 * requester's own rows) is preserved so the responder still recognises it.
 */
export function maskAnonAuthor<T extends Record<string, unknown>>(row: T): T {
  if (row.audience !== 'Anon') return row;
  return { ...row, user_id: null, user_fid: null, user_fname: 'Anonymous' };
}

// ── Sealed (Private / Allowlist) answer helpers ─────────────────────────────
// Spec: docs/specs/private-answer-encryption.md §7.5–§7.6. The D1 row for a
// sealed answer carries the '[encrypted]' placeholder and only non-content
// keys of answer_data; the content lives in the envelope in Q Storage and is
// opened only here, after the caller's ACL check.


export interface SealedAnswerPayload {
  value?: string;
  answer_data?: Record<string, unknown> | null;
  reasoning?: string | null;
}

/** `qstorage:answers/private/<id>` → `answers/private/<id>`; null when the row has no ref. */
export function storageKeyOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref === '') return null;
  return ref.startsWith('qstorage:') ? ref.slice('qstorage:'.length) : ref;
}

/** D1 answer_data is a JSON string; hand back the object (or null). */
export function parseAnswerData(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' ? v as Record<string, unknown> : null;
}

/**
 * What a sealed row may keep in D1 `answer_data`: the allowlist references the
 * read-time ACL needs, never `index` / `indices` / `text` / `iso` / `value`.
 * Returns the JSON string for the column, or null when nothing survives.
 */
export function stripAnswerDataContent(data: unknown): string | null {
  const obj = parseAnswerData(data);
  if (!obj) return null;
  const kept: Record<string, unknown> = {};
  if (Array.isArray(obj.allowlist)) kept.allowlist = obj.allowlist;
  if (typeof obj.allowlist_id === 'string') kept.allowlist_id = obj.allowlist_id;
  return Object.keys(kept).length ? JSON.stringify(kept) : null;
}

/** Storage key for a sealed answer of the given audience. */
export function sealedAnswerKey(audience: string, answerId: string): string {
  return `answers/${audience.toLowerCase()}/${answerId}`;
}

/**
 * Open the sealed payload of a Private / Allowlist row. Null when the row has
 * no storage ref or the object is missing. Throws on a sealed object that
 * does not open (wrong context, unknown key) — callers log and degrade.
 */
export async function openSealedAnswer(
  env: Env,
  row: { storage_ref?: unknown; audience?: unknown; user_id?: unknown },
): Promise<SealedAnswerPayload | null> {
  const key = storageKeyOf(row.storage_ref);
  if (!key) return null;
  return SecretStore.getJSON<SealedAnswerPayload>(env, key, {
    tier: String(row.audience),
    owner: Number(row.user_id),
  });
}
