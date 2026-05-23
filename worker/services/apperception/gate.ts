// apperception — $QQ-balance gate.
//
// Thin wrapper around values' gate. Same token, same threshold (4.42M $QQ).
// Reused directly rather than copied to avoid drift.

import { checkQQGate, type QQGateState, QQ_THRESHOLD_WEI } from '../values/gate';

export { type QQGateState, QQ_THRESHOLD_WEI };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function checkQQGateApperception(env: Env, fid: number): Promise<QQGateState> {
  return checkQQGate(env, fid);
}
