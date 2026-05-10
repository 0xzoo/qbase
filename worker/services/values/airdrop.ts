// values — airdrop config + thin wrapper around the shared quizAirdrop
// pipeline. Same shape as bartlet/airdrop.ts: 4.42M $QQ per user, Neynar
// score ≥ 0.9, 1000-slot cohort cap. Data flows through the shared
// quiz_airdrops + quiz_cohort_counters tables (quiz_id='values').
//
// Tokenomics rationale: same amount as bartlet so the two airdrops compose
// cleanly with the values $QQ-balance gate (4.42M threshold). A user who
// completes both quizzes ends up at 8.84M without buying anything; if they
// take values fresh (skipped bartlet), the 4.42M airdrop alone unlocks the
// gate. The Flaunch-fee revenue path comes from the bartlet *unlock* (2.21M)
// and any users past the 1000-slot cap.

import {
  runQuizAirdrop,
  type AirdropContext as GenericContext,
  type AirdropOutcome,
} from '../quizAirdrop';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const VALUES_AIRDROP_AMOUNT_TOKENS = '4420000';
const VALUES_NEYNAR_SCORE_THRESHOLD = 0.9;
const VALUES_COHORT_CAP = 1000;

export type { AirdropOutcome };

export interface AirdropContext extends GenericContext {
  env: Env;
}

export async function runValuesAirdrop(
  ctx: AirdropContext,
): Promise<AirdropOutcome> {
  return runQuizAirdrop(
    ctx.env,
    {
      quizId: 'values',
      enabled: ctx.env.VALUES_AIRDROP_ENABLED === '1',
      amountTokens: VALUES_AIRDROP_AMOUNT_TOKENS,
      neynarScoreThreshold: VALUES_NEYNAR_SCORE_THRESHOLD,
      cohortCap: VALUES_COHORT_CAP,
    },
    { fid: ctx.fid, sid: ctx.sid },
  );
}
