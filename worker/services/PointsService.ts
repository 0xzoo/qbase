/**
 * PointsService - Centralized QP (Qbase Points) management
 * 
 * Handles:
 * - Point initialization for new users
 * - Point balance retrieval
 * - Point deductions (spending)
 * - Point additions (earning)
 * - Daily allowance resets
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface UserPoints {
  allowance: number;    // Daily grant that resets at midnight UTC (20 base + tier bonus based on staked $QQ)
  earned: number;       // Earned during the month from rewards (quiz unlocks, answer saves)
  balance: number;      // Purchased QP with $QQ that persists (doesn't expire)
  lastResetAt?: string; // ISO timestamp of last allowance reset (for lazy reset)
}

export interface PointsTransaction {
  fid: number;
  amount: number;
  type: 'deduct' | 'add';
  reason: string;
  timestamp: string;
}

/**
 * Result of a point deduction, including breakdown of where points came from
 */
export interface DeductResult {
  points: UserPoints;
  deductedFromAllowance: number;
  deductedFromBalance: number;
}

export class PointsService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Tier allowance amounts
   */
  private static readonly TIER_ALLOWANCES: Record<'Member' | 'Pro' | 'Whale', number> = {
    'Member': 20,
    'Pro': 150,
    'Whale': 300
  };

  /**
   * Get default initial points for a new user
   */
  private getDefaultPoints(): UserPoints {
    return {
      allowance: 20,  // Default daily allowance (Member tier)
      earned: 0,       // No earned QP yet
      balance: 0,      // No purchased QP yet
      lastResetAt: new Date().toISOString() // Initialize with current time
    };
  }

  /**
   * Check if allowance should be reset (crossed midnight UTC since last reset)
   */
  private shouldResetAllowance(lastResetAt?: string): boolean {
    if (!lastResetAt) return true; // No timestamp = needs reset (migration case)
    
    const lastReset = new Date(lastResetAt);
    const now = new Date();
    
    // Get UTC date (YYYY-MM-DD) for comparison
    const lastResetDate = lastReset.toISOString().split('T')[0];
    const currentDate = now.toISOString().split('T')[0];
    
    // Reset if we're on a different UTC date
    return currentDate > lastResetDate;
  }

  /**
   * Get user's tier for allowance calculation
   * TODO: Implement tier lookup based on staked $QQ when tokenomics go live
   */
  private async getUserTier(_fid: number): Promise<'Member' | 'Pro' | 'Whale'> {
    // For now, default to Member tier
    // Future: query staking contract or DB for user's staked amount
    return 'Member';
  }

  /**
   * Get user's current points, initializing if necessary
   * Automatically resets daily allowance at midnight UTC if needed
   */
  async getPoints(fid: number): Promise<UserPoints> {
    const pointsStr = await this.env.KV_USER_POINTS.get(fid.toString());

    if (!pointsStr) {
      // Initialize points for new user
      const initialPoints = this.getDefaultPoints();
      
      await this.env.KV_USER_POINTS.put(
        fid.toString(),
        JSON.stringify(initialPoints)
      );
      
      console.log(`[PointsService] Initialized points for new user FID ${fid}:`, initialPoints);
      return initialPoints;
    }

    const points = JSON.parse(pointsStr) as UserPoints;
    
    // Check if we need to reset daily allowance (crossed midnight UTC)
    if (this.shouldResetAllowance(points.lastResetAt)) {
      const tier = await this.getUserTier(fid);
      
      // Reset allowance based on tier
      points.allowance = PointsService.TIER_ALLOWANCES[tier];
      points.lastResetAt = new Date().toISOString();
      
      // Save updated points
      await this.env.KV_USER_POINTS.put(
        fid.toString(),
        JSON.stringify(points)
      );
      
      console.log(`[PointsService] Auto-reset daily allowance for FID ${fid} (${tier} tier). New allowance: ${points.allowance}`);
    }

    return points;
  }

  /**
   * Get total spendable QP (allowance + balance only, earned is not spendable)
   */
  getTotalSpendable(points: UserPoints): number {
    return (points.allowance || 0) + (points.balance || 0);
  }

  /**
   * Check if user has sufficient balance
   */
  async hasSufficientBalance(fid: number, amount: number): Promise<boolean> {
    const points = await this.getPoints(fid);
    return this.getTotalSpendable(points) >= amount;
  }

  /**
   * Deduct points from user's spendable QP
   * Deduction priority: allowance -> balance (earned is NEVER spent)
   * Returns DeductResult with breakdown, or null if insufficient balance
   */
  async deductPoints(
    fid: number, 
    amount: number, 
    reason: string = 'deduction'
  ): Promise<DeductResult | null> {
    const points = await this.getPoints(fid);
    const totalSpendable = this.getTotalSpendable(points);

    // Check if user has enough points
    if (totalSpendable < amount) {
      console.log(`[PointsService] Insufficient balance for FID ${fid}. Required: ${amount}, Available: ${totalSpendable}`);
      return null;
    }

    // Deduct in priority order: allowance -> balance
    // NOTE: earned is NEVER spent, only accumulated for monthly $QQ conversion
    let remaining = amount;
    let deductedFromAllowance = 0;
    let deductedFromBalance = 0;
    
    // 1. Deduct from allowance first (use it or lose it daily)
    if (points.allowance > 0) {
      const deductFromAllowance = Math.min(points.allowance, remaining);
      points.allowance -= deductFromAllowance;
      remaining -= deductFromAllowance;
      deductedFromAllowance = deductFromAllowance;
    }
    
    // 2. Then deduct from balance (purchased QP)
    if (remaining > 0 && points.balance > 0) {
      const deductFromBalance = Math.min(points.balance, remaining);
      points.balance -= deductFromBalance;
      remaining -= deductFromBalance;
      deductedFromBalance = deductFromBalance;
    }

    // Update in KV
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );

    console.log(`[PointsService] Deducted ${amount} QP from FID ${fid} (${reason}). Breakdown: ${deductedFromAllowance} from allowance, ${deductedFromBalance} from balance. New state: allowance=${points.allowance}, earned=${points.earned}, balance=${points.balance}`);
    
    return { points, deductedFromAllowance, deductedFromBalance };
  }

  /**
   * Refund points to the same buckets they were deducted from
   * Use the breakdown from deductPoints to ensure correct refund
   */
  async refundPoints(
    fid: number,
    deductedFromAllowance: number,
    deductedFromBalance: number,
    reason: string = 'refund'
  ): Promise<UserPoints> {
    const points = await this.getPoints(fid);

    // Refund to the same buckets
    points.allowance += deductedFromAllowance;
    points.balance += deductedFromBalance;

    // Update in KV
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );

    const totalRefunded = deductedFromAllowance + deductedFromBalance;
    console.log(`[PointsService] Refunded ${totalRefunded} QP to FID ${fid} (${reason}). Breakdown: ${deductedFromAllowance} to allowance, ${deductedFromBalance} to balance. New state: allowance=${points.allowance}, earned=${points.earned}, balance=${points.balance}`);
    
    return points;
  }

  /**
   * Add earned points (from rewards like quiz unlocks, answer saves)
   * These accumulate monthly and are claimable for $QQ at month end
   */
  async addEarnedPoints(
    fid: number, 
    amount: number, 
    reason: string = 'reward'
  ): Promise<UserPoints> {
    const points = await this.getPoints(fid);

    // Add to earned
    points.earned += amount;

    // Update in KV
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );

    console.log(`[PointsService] Added ${amount} earned QP to FID ${fid} (${reason}). New earned: ${points.earned}`);
    
    return points;
  }

  /**
   * Add balance points (purchased with $QQ)
   * These persist and don't expire
   */
  async addBalancePoints(
    fid: number, 
    amount: number, 
    reason: string = 'QP purchase'
  ): Promise<UserPoints> {
    const points = await this.getPoints(fid);

    // Add to balance
    points.balance += amount;

    // Update in KV
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );

    console.log(`[PointsService] Added ${amount} balance QP to FID ${fid} (${reason}). New balance: ${points.balance}`);
    
    return points;
  }

  /**
   * Legacy method for backward compatibility
   * Adds to earned points by default
   */
  async addPoints(
    fid: number, 
    amount: number, 
    reason: string = 'reward'
  ): Promise<UserPoints> {
    return this.addEarnedPoints(fid, amount, reason);
  }

  /**
   * Manually reset daily allowance for a user
   * Note: Normally handled automatically by getPoints() at midnight UTC.
   * This method is for manual resets or administrative use.
   * @param tier - User's staking tier (Member=20, Pro=150, Whale=300)
   */
  async resetDailyAllowance(fid: number, tier: 'Member' | 'Pro' | 'Whale' = 'Member'): Promise<UserPoints> {
    // Use getRawPoints to avoid triggering auto-reset
    const pointsStr = await this.env.KV_USER_POINTS.get(fid.toString());
    const points = pointsStr ? JSON.parse(pointsStr) as UserPoints : this.getDefaultPoints();
    
    // Reset allowance based on tier
    points.allowance = PointsService.TIER_ALLOWANCES[tier];
    points.lastResetAt = new Date().toISOString();

    // Update in KV
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );

    console.log(`[PointsService] Manual reset daily allowance for FID ${fid} (${tier}). New state:`, points);
    
    return points;
  }

  /**
   * Claim earned QP at end of month (converts to $QQ via treasury pool)
   * This resets the earned counter after claiming
   */
  async claimEarnedPoints(fid: number): Promise<{ earnedAmount: number; qqAmount: number }> {
    const points = await this.getPoints(fid);
    const earnedAmount = points.earned;
    
    // Reset earned to 0 after claiming
    points.earned = 0;
    
    await this.env.KV_USER_POINTS.put(
      fid.toString(),
      JSON.stringify(points)
    );
    
    // TODO: Calculate $QQ amount based on treasury pool
    // For now, placeholder conversion
    const qqAmount = earnedAmount / 500; // Example: 500 QP = 1 $QQ worth
    
    console.log(`[PointsService] Claimed ${earnedAmount} earned QP for FID ${fid}. Converted to ${qqAmount} $QQ.`);
    
    return { earnedAmount, qqAmount };
  }

  /**
   * Factory method to create service from env
   */
  static fromEnv(env: Env): PointsService {
    return new PointsService(env);
  }
}

