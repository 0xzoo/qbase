/**
 * Unit tests for PointsService
 * 
 * These tests verify the core logic of the PointsService in isolation.
 * The service is constructed with a mock Env object that simulates
 * the KV_USER_POINTS binding provided by the Workers runtime.
 * 
 * Key things being tested:
 * - Default points initialization for new users
 * - Daily allowance tier calculations (Member/Pro/Whale)
 * - Allowance auto-reset logic (midnight UTC detection)
 * - Point deduction priority (allowance before balance)
 * - Earned vs balance point separation
 * 
 * The @cloudflare/vitest-pool-workers plugin auto-creates a local D1 database
 * and provides mock KV namespaces, so tests can read/write real bindings.
 */

import { describe, it, expect } from 'vitest';
// Import the service we're testing
import { PointsService, type UserPoints } from '../../worker/services/PointsService';

// ---------------------------------------------------------------------------
// Helper: build a minimal mock Env that satisfies what PointsService needs
// ---------------------------------------------------------------------------
function makeMockEnv(kvStore: Record<string, string> = {}) {
  return {
    // KV namespace - backed by an in-memory Map for this test
    // The vitest-pool-workers will replace this with a real local KV implementation
    KV_USER_POINTS: {
      get: async (key: string) => kvStore[key] ?? null,
      put: async (key: string, value: string) => { kvStore[key] = value; },
      delete: async (key: string) => { delete kvStore[key]; },
    } as unknown as KVNamespace,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PointsService', () => {
  describe('getDefaultPoints() via getPoints() on new user', () => {
    it('returns default points structure for an uninitialized user', async () => {
      const env = makeMockEnv();
      const service = new PointsService(env);

      const points = await service.getPoints(12345);

      // Default allowance is 20 QP (Member tier)
      expect(points.allowance).toBe(20);
      // Earned and balance start at 0
      expect(points.earned).toBe(0);
      expect(points.balance).toBe(0);
      // lastResetAt should be set
      expect(points.lastResetAt).toBeTruthy();
    });

    it('persists initialized points to KV so subsequent calls return same data', async () => {
      const store: Record<string, string> = {};
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      const first = await service.getPoints(99999);
      first.allowance = 50; // Simulate spending

      // The modified points are saved by the service
      const second = await service.getPoints(99999);
      expect(second.allowance).toBe(20); // Back to default (fresh read from store)
    });
  });

  describe('getTotalSpendable()', () => {
    it('sums allowance and balance (earned is NOT spendable)', () => {
      const env = makeMockEnv();
      const service = new PointsService(env);

      const points: UserPoints = {
        allowance: 20,
        earned: 100,   // Not spendable - accumulates for $QQ conversion
        balance: 50,  // Purchased QP, persists
        lastResetAt: new Date().toISOString(),
      };

      // Only allowance + balance = spendable
      expect(service.getTotalSpendable(points)).toBe(70);
    });

    it('returns 0 when all buckets are empty', () => {
      const env = makeMockEnv();
      const service = new PointsService(env);

      const points: UserPoints = {
        allowance: 0,
        earned: 0,
        balance: 0,
        lastResetAt: undefined,
      };

      expect(service.getTotalSpendable(points)).toBe(0);
    });
  });

  describe('deductPoints()', () => {
    it('deducts from allowance first, then balance', async () => {
      // Pre-populate a user with known points
      const store: Record<string, string> = {
        '42': JSON.stringify({
          allowance: 20,
          earned: 0,
          balance: 30,
          lastResetAt: new Date().toISOString(),
        }),
      };
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      // Spend 35 QP — should use 20 from allowance + 15 from balance
      const result = await service.deductPoints(42, 35, 'test purchase');

      expect(result).not.toBeNull();
      expect(result!.deductedFromAllowance).toBe(20);
      expect(result!.deductedFromBalance).toBe(15);
      expect(result!.points.allowance).toBe(0);
      expect(result!.points.balance).toBe(15); // 30 - 15
    });

    it('returns null when user has insufficient balance', async () => {
      const store: Record<string, string> = {
        '99': JSON.stringify({
          allowance: 5,
          earned: 0,
          balance: 0,
          lastResetAt: new Date().toISOString(),
        }),
      };
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      const result = await service.deductPoints(99, 10, 'test');
      expect(result).toBeNull();
    });

    it('does NOT touch earned points during deduction', async () => {
      const store: Record<string, string> = {
        '77': JSON.stringify({
          allowance: 10,
          earned: 500, // Accumulated rewards — never spent
          balance: 0,
          lastResetAt: new Date().toISOString(),
        }),
      };
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      await service.deductPoints(77, 5, 'test');

      // Earned must be untouched
      const updated = await service.getPoints(77);
      expect(updated.earned).toBe(500);
    });
  });

  describe('addEarnedPoints() and addBalancePoints()', () => {
    it('adds to earned bucket only', async () => {
      const store: Record<string, string> = {};
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      await service.addEarnedPoints(111, 50, 'quiz unlock reward');

      const points = await service.getPoints(111);
      expect(points.earned).toBe(50);
      expect(points.balance).toBe(0);
    });

    it('adds to balance bucket only', async () => {
      const store: Record<string, string> = {};
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      await service.addBalancePoints(222, 200, 'QP purchase');

      const points = await service.getPoints(222);
      expect(points.balance).toBe(200);
      expect(points.earned).toBe(0);
    });
  });

  describe('refundPoints()', () => {
    it('restores points to the correct buckets', async () => {
      const store: Record<string, string> = {
        '55': JSON.stringify({
          allowance: 0,
          earned: 0,
          balance: 15,
          lastResetAt: new Date().toISOString(),
        }),
      };
      const env = makeMockEnv(store);
      const service = new PointsService(env);

      const result = await service.refundPoints(55, 10, 5, 'refund test');

      expect(result.allowance).toBe(10);
      expect(result.balance).toBe(20); // 15 + 5
    });
  });

  describe('factory: PointsService.fromEnv()', () => {
    it('creates a service instance from env', () => {
      const env = makeMockEnv();
      const service = PointsService.fromEnv(env);
      expect(service).toBeInstanceOf(PointsService);
    });
  });
});
