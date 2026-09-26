/**
 * The committed record of a closed wave (plan 2026-09-25 §7.3–§7.4, §8.7).
 *
 * A bundle is canonical JSON (RFC 8785) with `schema: "qbase.wave.v1"`: the
 * question, the wave's rule, `n`, `n_verified` (a count, never nullifiers),
 * the tally, the wave's Public answers with their authors, and its Anon
 * answers as `{receipt_sha256, answer}` only (receipts.ts: the owner can find
 * theirs, nobody else can link one). Secret answers are in neither. Consent is
 * the per-answer audience chooser: Public means published with your name,
 * Anon means published without it.
 *
 * The tally is the results page's own wave tally (AggregateResultsService),
 * so the page, the OG chart, the bundle and the verify route all count the
 * same way: latest answer per person, Public + Anon.
 */

import { getAggregateResults, type AggregateResults } from '../AggregateResultsService';
import { parsePollGate, type PollRow } from '../PollService';
import { ACCOUNT_ID_MIN } from '../accounts/migrationSql';
import { canonicalJson, sha256Hex } from './canonicalJson';
import { receiptFor, receiptHash, type ReceiptEnv } from './receipts';

export const BUNDLE_SCHEMA = 'qbase.wave.v2';
export const DEFAULT_QUESTIONS_NAME = 'q.askqbase.eth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export interface BundleEnv extends ReceiptEnv {
  DB: D1Database;
  HOSTNAME?: string;
  ENS_QUESTIONS_NAME?: string;
}

/** What the tally commits to: counts only, no percentages (they are derived). */
export interface WaveTally {
  type: string;
  total: number;
  distribution: Array<{ label: string; count: number }>;
}

export interface BundleRow {
  id: string;
  answer: string;
  answered_at: string | null;
  handle: string | null;
  fid: number | null;
  /** The qbase account id once accounts are cut over; null before. */
  account: number | null;
}

/** An Anon answer: findable by its owner through their receipt, linkable by nobody else. */
export interface AnonBundleRow {
  receipt_sha256: string;
  answer: string;
}

export interface WaveBundle {
  schema: typeof BUNDLE_SCHEMA;
  question: { id: string; text: string; text_sha256: string; type: string; options: string[]; ens_name: string };
  wave: { id: string; kind: string; opened_at: string; closed_at: string; gate: string; published_by: string };
  n: number;
  n_verified: number;
  tally: WaveTally;
  rows: BundleRow[];
  anon_rows: AnonBundleRow[];
  rows_rule: string;
  source: string;
}

export interface BuiltBundle {
  bundle: WaveBundle;
  json: string;
  sha256: `0x${string}`;
  tallySha256: `0x${string}`;
}

export function questionEnsName(env: Pick<BundleEnv, 'ENS_QUESTIONS_NAME'>, questionId: string): string {
  return `${questionId.toLowerCase()}.${env.ENS_QUESTIONS_NAME || DEFAULT_QUESTIONS_NAME}`;
}

/** The wave's rule as one short string; a holder gate's FID list never leaves the database. */
export function gateRule(raw: string | null): string {
  const gate = parsePollGate(raw);
  if (!gate) return 'open';
  switch (gate.type) {
    case 'world_id':
      return `world_id:${gate.credential}`;
    case 'nft_snapshot':
      return `nft_snapshot:${gate.chain}:${gate.contract.toLowerCase()}`;
    case 'token_snapshot':
      return `token_snapshot:${gate.chain}:${gate.contract.toLowerCase()}:>=${gate.min_balance}`;
    default:
      return 'unknown';
  }
}

export function tallyOf(results: AggregateResults): WaveTally {
  return {
    type: results.question.type,
    total: results.total,
    distribution: results.distribution.map((d) => ({ label: d.label, count: d.count })),
  };
}

/** The live tally of a wave, in the committed shape. Null when the wave's question is gone. */
export async function liveTally(env: BundleEnv, poll: PollRow): Promise<WaveTally | null> {
  const results = await getAggregateResults(env.DB, poll.question_id, poll);
  return results ? tallyOf(results) : null;
}

export async function tallySha256(tally: WaveTally): Promise<`0x${string}`> {
  return sha256Hex(canonicalJson(tally));
}

async function publishedBy(env: BundleEnv, poll: PollRow): Promise<string> {
  if (poll.author_fid == null) return 'qbase';
  const u = await env.DB.prepare('SELECT fname FROM Users WHERE fid = ?').bind(poll.author_fid).first() as { fname: string | null } | null;
  return u?.fname ? `@${u.fname}` : `fid:${poll.author_fid}`;
}

async function publicRows(env: BundleEnv, poll: PollRow): Promise<BundleRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT a.id, a.value, a.created_at, a.user_id, u.fname, ac.value AS fc_fid
    FROM Answers a
    LEFT JOIN Users u ON u.fid = a.user_id
    LEFT JOIN account_credentials ac ON ac.kind = 'farcaster' AND ac.account_id = a.user_id
    WHERE a.poll_id = ? AND a.audience = 'Public' AND a.created_at <= ?
    ORDER BY a.created_at, a.id
  `).bind(poll.id, poll.closes_at).all();
  return ((results || []) as Array<{
    id: string; value: string; created_at: string | null; user_id: number; fname: string | null; fc_fid: string | null;
  }>).map((r) => {
    const key = Number(r.user_id);
    const isAccount = key >= ACCOUNT_ID_MIN;
    return {
      id: String(r.id),
      answer: String(r.value),
      answered_at: r.created_at,
      handle: r.fname ?? null,
      fid: r.fc_fid != null ? Number(r.fc_fid) : (isAccount ? null : key),
      account: isAccount ? key : null,
    };
  });
}

/** Every Anon answer on the wave up to its close, sorted by receipt hash so order says nothing about time. */
async function anonRows(env: BundleEnv, poll: PollRow): Promise<AnonBundleRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT id, value FROM Answers
    WHERE poll_id = ? AND audience = 'Anon' AND created_at <= ?
  `).bind(poll.id, poll.closes_at).all();
  const rows = await Promise.all(((results || []) as Array<{ id: string; value: string }>).map(async (r) => ({
    receipt_sha256: await receiptHash(await receiptFor(env, String(r.id))),
    answer: String(r.value),
  })));
  return rows.sort((a, b) => (a.receipt_sha256 < b.receipt_sha256 ? -1 : a.receipt_sha256 > b.receipt_sha256 ? 1 : 0));
}

async function verifiedCount(env: BundleEnv, pollId: string): Promise<number> {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM world_verifications WHERE poll_id = ?').bind(pollId).first() as { n: number } | null;
    return Number(row?.n ?? 0);
  } catch {
    return 0; // no world_verifications table (0073 not applied): nothing was verified
  }
}

/** Build the bundle for a wave. Null when the wave's question no longer exists. */
export async function buildWaveBundle(env: BundleEnv, poll: PollRow): Promise<BuiltBundle | null> {
  const results = await getAggregateResults(env.DB, poll.question_id, poll);
  if (!results) return null;
  const tally = tallyOf(results);
  const host = env.HOSTNAME || 'qbase.tech';
  const bundle: WaveBundle = {
    schema: BUNDLE_SCHEMA,
    question: {
      id: results.question.id,
      text: results.question.stem,
      text_sha256: await sha256Hex(results.question.stem),
      type: results.question.type,
      options: results.question.options,
      ens_name: questionEnsName(env, results.question.id),
    },
    wave: {
      id: poll.id,
      kind: poll.kind ?? 'measure',
      opened_at: poll.created_at,
      closed_at: poll.closes_at,
      gate: gateRule(poll.eligibility_gate),
      published_by: await publishedBy(env, poll),
    },
    n: tally.total,
    n_verified: await verifiedCount(env, poll.id),
    tally,
    rows: await publicRows(env, poll),
    anon_rows: await anonRows(env, poll),
    rows_rule: 'rows: Public answers on this wave up to its close, with their authors. anon_rows: Anon answers up to its close, each under the sha256 of a receipt only its author can fetch, sorted by that hash. Secret answers are in neither. Both lists include answers a person later replaced; the tally counts each person once, by their latest answer.',
    source: `https://${host}/poll/${poll.id}/results`,
  };
  const json = canonicalJson(bundle);
  return { bundle, json, sha256: await sha256Hex(json), tallySha256: await tallySha256(tally) };
}
