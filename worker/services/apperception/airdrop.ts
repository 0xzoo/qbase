// apperception — airdrop config + thin wrapper around shared quizAirdrop
// pipeline. 4.53M $QQ per user (so trinity total = 13.37M). Neynar score
// ≥ 0.9, 1000-slot cohort cap. quiz_id='apperception'.

import {
  runQuizAirdrop,
  type AirdropContext as GenericContext,
  type AirdropOutcome,
} from '../quizAirdrop';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const APPERCEPTION_AIRDROP_AMOUNT_TOKENS = '4530000';  // 13.37M trinity total
const APPERCEPTION_NEYNAR_SCORE_THRESHOLD = 0.9;
const APPERCEPTION_COHORT_CAP = 1000;

export type { AirdropOutcome };

export interface AirdropContext extends GenericContext {
  env: Env;
}

export async function runApperceptionAirdrop(
  ctx: AirdropContext,
): Promise<AirdropOutcome> {
  return runQuizAirdrop(
    ctx.env,
    {
      quizId: 'apperception',
      enabled: ctx.env.APPERCEPTION_AIRDROP_ENABLED === '1',
      amountTokens: APPERCEPTION_AIRDROP_AMOUNT_TOKENS,
      neynarScoreThreshold: APPERCEPTION_NEYNAR_SCORE_THRESHOLD,
      cohortCap: APPERCEPTION_COHORT_CAP,
    },
    { fid: ctx.fid, sid: ctx.sid },
  );
}
