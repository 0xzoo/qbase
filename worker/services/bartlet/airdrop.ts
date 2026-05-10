// bartlet — airdrop config + thin wrapper around the generic quizAirdrop
// pipeline. The actual flow (Neynar gate, cohort bump, transfer, ledger
// insert) lives in worker/services/quizAirdrop.ts so values + future
// bespoke quizzes share one implementation.
//
// Behavior is unchanged from the previous standalone bartlet/airdrop.ts:
// 4.42M $QQ per user, Neynar score ≥ 0.9, 1000-slot cohort cap. Data has
// been migrated from bartlet_airdrops → quiz_airdrops with quiz_id='bartlet'
// (see migrations/0058_create_quiz_airdrops_table.sql).

import {
  runQuizAirdrop,
  pickRecipientAddress as pickRecipientAddressGeneric,
  type AirdropContext as GenericContext,
  type AirdropOutcome,
} from '../quizAirdrop';
import { fetchNeynarUser, type NeynarUser } from '../NeynarUserService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const BARTLET_AIRDROP_AMOUNT_TOKENS = '4420000';
const BARTLET_NEYNAR_SCORE_THRESHOLD = 0.9;
const BARTLET_COHORT_CAP = 1000;

export type { AirdropOutcome };

export interface AirdropContext extends GenericContext {
  env: Env;
}

export async function runAirdrop(ctx: AirdropContext): Promise<AirdropOutcome> {
  return runQuizAirdrop(
    ctx.env,
    {
      quizId: 'bartlet',
      enabled: ctx.env.BARTLET_AIRDROP_ENABLED === '1',
      amountTokens: BARTLET_AIRDROP_AMOUNT_TOKENS,
      neynarScoreThreshold: BARTLET_NEYNAR_SCORE_THRESHOLD,
      cohortCap: BARTLET_COHORT_CAP,
    },
    { fid: ctx.fid, sid: ctx.sid },
  );
}

// ─── Re-exports for backward-compat with bartlet.ts callers ──────────────

export type { NeynarUser };
export { fetchNeynarUser };
export const pickRecipientAddress = pickRecipientAddressGeneric;
