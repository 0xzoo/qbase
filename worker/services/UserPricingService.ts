import type { UserPricingConfig } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Default pricing configuration for new users
 */
export const DEFAULT_USER_PRICING_CONFIG: UserPricingConfig = {
  enabled: false,
  social_qp_price: 10, // Default 10 QP for social direct queries
  expert_qq_price: undefined, // No default $QQ price (must be set explicitly)
  expertise_multiplier: 1.0,
  min_price: undefined,
  max_price: undefined,
  category_pricing: {},
  updatedAt: Date.now(),
};

/**
 * Service for managing user pricing configuration in KV storage
 * Uses KV_USER_PROFILES namespace with key pattern: user_pricing:{fid}
 */
export class UserPricingService {
  private kv: any;

  constructor(kv: any) {
    this.kv = kv;
  }

  /**
   * Create instance from environment bindings
   */
  static fromEnv(env: Env): UserPricingService {
    return new UserPricingService(env.KV_USER_PROFILES);
  }

  /**
   * Generate KV key for user pricing config
   */
  private getKey(fid: number): string {
    return `user_pricing:${fid}`;
  }

  /**
   * Get user pricing configuration from KV
   * Returns default config if none exists
   */
  async getPricingConfig(fid: number): Promise<UserPricingConfig> {
    const key = this.getKey(fid);
    const data = await this.kv.get(key);

    if (!data) {
      // Return default config for new users
      return { ...DEFAULT_USER_PRICING_CONFIG };
    }

    try {
      const config = JSON.parse(data) as UserPricingConfig;
      // Merge with defaults to ensure all fields exist (for forward compatibility)
      return {
        ...DEFAULT_USER_PRICING_CONFIG,
        ...config,
        category_pricing: {
          ...DEFAULT_USER_PRICING_CONFIG.category_pricing,
          ...config.category_pricing,
        },
      };
    } catch (error) {
      console.error(`Failed to parse pricing config for FID ${fid}:`, error);
      return { ...DEFAULT_USER_PRICING_CONFIG };
    }
  }

  /**
   * Update user pricing configuration in KV
   * Performs a partial update - only provided fields are updated
   */
  async updatePricingConfig(
    fid: number,
    updates: Partial<Omit<UserPricingConfig, 'updatedAt'>>
  ): Promise<UserPricingConfig> {
    const currentConfig = await this.getPricingConfig(fid);

    const updatedConfig: UserPricingConfig = {
      ...currentConfig,
      ...updates,
      // Deep merge category_pricing
      category_pricing: {
        ...currentConfig.category_pricing,
        ...updates.category_pricing,
      },
      updatedAt: Date.now(),
    };

    const key = this.getKey(fid);
    await this.kv.put(key, JSON.stringify(updatedConfig));

    return updatedConfig;
  }

  /**
   * Reset user pricing configuration to defaults
   */
  async resetPricingConfig(fid: number): Promise<UserPricingConfig> {
    const defaultConfig: UserPricingConfig = {
      ...DEFAULT_USER_PRICING_CONFIG,
      updatedAt: Date.now(),
    };

    const key = this.getKey(fid);
    await this.kv.put(key, JSON.stringify(defaultConfig));

    return defaultConfig;
  }

  /**
   * Delete user pricing configuration from KV
   */
  async deletePricingConfig(fid: number): Promise<void> {
    const key = this.getKey(fid);
    await this.kv.delete(key);
  }

  /**
   * Check if user has custom pricing configuration
   */
  async hasCustomPricing(fid: number): Promise<boolean> {
    const key = this.getKey(fid);
    const data = await this.kv.get(key);
    if (!data) return false;

    try {
      const config = JSON.parse(data) as UserPricingConfig;
      return config.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Calculate price for a direct query based on user's pricing config
   * Returns the price in the appropriate currency (QP or $QQ)
   */
  async calculatePrice(
    fid: number,
    queryType: 'social' | 'expert',
    category?: string
  ): Promise<{ price: number; currency: 'qp' | 'qq' }> {
    const config = await this.getPricingConfig(fid);

    if (!config.enabled) {
      // Return default pricing
      if (queryType === 'social') {
        return { price: DEFAULT_USER_PRICING_CONFIG.social_qp_price || 10, currency: 'qp' };
      } else {
        // Expert queries require explicit pricing
        throw new Error('Expert queries require enabled pricing configuration');
      }
    }

    let basePrice: number;
    let currency: 'qp' | 'qq';

    if (queryType === 'social') {
      basePrice = config.social_qp_price || DEFAULT_USER_PRICING_CONFIG.social_qp_price || 10;
      currency = 'qp';
    } else {
      if (!config.expert_qq_price) {
        throw new Error('Expert queries require expert_qq_price to be set');
      }
      basePrice = config.expert_qq_price;
      currency = 'qq';
    }

    // Apply category-specific pricing if available
    if (category && config.category_pricing?.[category]) {
      const categoryPricing = config.category_pricing[category];
      if (queryType === 'social' && categoryPricing.qp_price !== undefined) {
        basePrice = categoryPricing.qp_price;
      } else if (queryType === 'expert' && categoryPricing.qq_price !== undefined) {
        basePrice = categoryPricing.qq_price;
      }
      // Apply category multiplier if specified
      if (categoryPricing.multiplier !== undefined) {
        basePrice = Math.round(basePrice * categoryPricing.multiplier);
      }
    }

    // Apply expertise multiplier
    if (config.expertise_multiplier !== undefined) {
      basePrice = Math.round(basePrice * config.expertise_multiplier);
    }

    // Apply min/max price constraints
    if (config.min_price !== undefined && basePrice < config.min_price) {
      basePrice = config.min_price;
    }
    if (config.max_price !== undefined && basePrice > config.max_price) {
      basePrice = config.max_price;
    }

    return { price: basePrice, currency };
  }
}

