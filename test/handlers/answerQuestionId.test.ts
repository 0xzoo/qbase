/**
 * The answer endpoint accepts both kinds of question id: UUIDs and the
 * readable ids of questions registered from quizzes (q_values_…,
 * q_apperception_…). Anything else is refused before any lookup.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleCreateAnswer } from '../../worker/handlers/answers/create';

async function post(q_id: string) {
  const res = await handleCreateAnswer(new Request('http://x/api/answers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q_id, value: 'x', audience: 'Public', user_id: 7, answer_type_id: 1 }),
  }), env);
  return { status: res.status, text: await res.text() };
}

describe('answer q_id format', () => {
  it('lets quiz question ids and UUIDs past the format check', async () => {
    for (const id of ['q_values_hard_truth', 'q_apperception_ikea_manual', '802af5e9-2f76-4195-8965-24d73241e3ba']) {
      expect((await post(id)).text).not.toBe('Invalid q_id format');
    }
  });
  it('refuses anything else', async () => {
    for (const id of ['Q_VALUES', "q_x'; DROP TABLE Answers;--", 'q_', 'not-a-uuid', `q_${'a'.repeat(121)}`]) {
      expect(await post(id)).toEqual({ status: 400, text: 'Invalid q_id format' });
    }
  });
});
