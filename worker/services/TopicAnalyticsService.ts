// @ts-nocheck
/**
 * TopicAnalyticsService
 * 
 * Service for computing topic trending metrics, momentum scores, and analytics.
 * Handles scheduled metric updates and time series data recording.
 */

import type { TopicMetrics, TopicWithMetrics, TimeSeriesPoint } from '../../src/lib/types';

export class TopicAnalyticsService {
  /**
   * Update metrics for a single topic
   * Called when new questions with this topic are created, or during scheduled updates
   * 
   * @param db - D1 database instance
   * @param topicId - Topic ID to update
   */
  static async updateTopicMetrics(
    db: any,
    topicId: number
  ): Promise<void> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;
    const month = 30 * day;
    
    // Calculate time thresholds
    const timestamp24hAgo = now - day;
    const timestamp7dAgo = now - week;
    const timestamp30dAgo = now - month;
    const timestamp7dBefore = now - (2 * week); // For growth rate calculation
    
    // Query aggregated metrics
    const metrics = await db.prepare(`
      SELECT 
        -- Volume metrics (all time)
        COUNT(DISTINCT qt.query_id) as total_questions,
        COALESCE(SUM(q.pub_answers + q.priv_answers), 0) as total_answers,
        COUNT(DISTINCT q.coiner_id) as total_contributors,
        
        -- Time-windowed question counts
        SUM(CASE WHEN q.created_at >= ? THEN 1 ELSE 0 END) as questions_24h,
        SUM(CASE WHEN q.created_at >= ? THEN 1 ELSE 0 END) as questions_7d,
        SUM(CASE WHEN q.created_at >= ? THEN 1 ELSE 0 END) as questions_30d,
        
        -- Previous period for growth calculation
        SUM(CASE WHEN q.created_at >= ? AND q.created_at < ? THEN 1 ELSE 0 END) as questions_prev_7d,
        
        -- Engagement metrics (from Farcaster tables)
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as total_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as total_recasts
        
      FROM QueryTopics qt
      INNER JOIN queries q ON qt.query_id = q.id
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      WHERE qt.topic_id = ?
      GROUP BY qt.topic_id
    `).bind(
      timestamp24hAgo,
      timestamp7dAgo,
      timestamp30dAgo,
      timestamp7dBefore,
      timestamp7dAgo,
      topicId
    ).first();
    
    if (!metrics || metrics.total_questions === 0) {
      // No questions for this topic - initialize with zeros
      await db.prepare(`
        INSERT INTO topic_metrics (
          topic_id, total_questions, total_answers, total_contributors,
          questions_24h, questions_7d, questions_30d,
          growth_rate_24h, growth_rate_7d, growth_rate_30d,
          avg_answers_per_question, total_likes, total_recasts,
          engagement_rate, momentum_score, trend_direction, last_updated
        ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'stable', ?)
        ON CONFLICT(topic_id) DO UPDATE SET
          total_questions = 0,
          last_updated = ?
      `).bind(topicId, now, now).run();
      return;
    }
    
    // Calculate derived metrics
    const avgAnswersPerQuestion = metrics.total_questions > 0 
      ? metrics.total_answers / metrics.total_questions 
      : 0;
    
    const engagementRate = metrics.total_questions > 0
      ? (metrics.total_likes + metrics.total_recasts) / metrics.total_questions
      : 0;
    
    // Calculate growth rates
    const growthRate7d = metrics.questions_prev_7d > 0
      ? ((metrics.questions_7d - metrics.questions_prev_7d) / metrics.questions_prev_7d) * 100
      : (metrics.questions_7d > 0 ? 100 : 0); // If no previous data but current data exists, 100% growth
    
    // Simple 24h growth rate (comparing to total - 24h to get implicit previous day)
    const questionsBeforeLast24h = metrics.total_questions - metrics.questions_24h;
    const growthRate24h = questionsBeforeLast24h > 0
      ? ((metrics.questions_24h - questionsBeforeLast24h) / questionsBeforeLast24h) * 100
      : (metrics.questions_24h > 0 ? 100 : 0);
    
    // 30d growth rate (comparing current 30d to previous 30d)
    const questionsPrev30d = metrics.total_questions - metrics.questions_30d;
    const growthRate30d = questionsPrev30d > 0
      ? ((metrics.questions_30d - questionsPrev30d) / questionsPrev30d) * 100
      : (metrics.questions_30d > 0 ? 100 : 0);
    
    // Calculate momentum score
    const momentumScore = this.calculateMomentumScore({
      questions_24h: metrics.questions_24h,
      growth_rate_7d: growthRate7d,
      engagement_rate: engagementRate,
      avg_answers_per_question: avgAnswersPerQuestion
    });
    
    // Determine trend direction
    let trendDirection: 'rising' | 'falling' | 'stable';
    if (growthRate7d > 10) {
      trendDirection = 'rising';
    } else if (growthRate7d < -10) {
      trendDirection = 'falling';
    } else {
      trendDirection = 'stable';
    }
    
    // Update topic_metrics table
    await db.prepare(`
      INSERT INTO topic_metrics (
        topic_id, total_questions, total_answers, total_contributors,
        questions_24h, questions_7d, questions_30d,
        growth_rate_24h, growth_rate_7d, growth_rate_30d,
        avg_answers_per_question, total_likes, total_recasts,
        engagement_rate, momentum_score, trend_direction, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        total_questions = excluded.total_questions,
        total_answers = excluded.total_answers,
        total_contributors = excluded.total_contributors,
        questions_24h = excluded.questions_24h,
        questions_7d = excluded.questions_7d,
        questions_30d = excluded.questions_30d,
        growth_rate_24h = excluded.growth_rate_24h,
        growth_rate_7d = excluded.growth_rate_7d,
        growth_rate_30d = excluded.growth_rate_30d,
        avg_answers_per_question = excluded.avg_answers_per_question,
        total_likes = excluded.total_likes,
        total_recasts = excluded.total_recasts,
        engagement_rate = excluded.engagement_rate,
        momentum_score = excluded.momentum_score,
        trend_direction = excluded.trend_direction,
        last_updated = excluded.last_updated
    `).bind(
      topicId,
      metrics.total_questions,
      metrics.total_answers,
      metrics.total_contributors,
      metrics.questions_24h,
      metrics.questions_7d,
      metrics.questions_30d,
      growthRate24h,
      growthRate7d,
      growthRate30d,
      avgAnswersPerQuestion,
      metrics.total_likes,
      metrics.total_recasts,
      engagementRate,
      momentumScore,
      trendDirection,
      now
    ).run();
  }
  
  /**
   * Bulk update all topic metrics
   * Run periodically (cron job or scheduled worker)
   * 
   * @param db - D1 database instance
   */
  static async updateAllTopicMetrics(
    db: any
  ): Promise<void> {
    console.log('Starting bulk topic metrics update');
    
    // Get all topic IDs
    const { results: topics } = await db.prepare(`
      SELECT id FROM Topics
    `).all();
    
    console.log(`Updating metrics for ${topics.length} topics`);
    
    // Update each topic
    for (const topic of topics) {
      try {
        await this.updateTopicMetrics(db, topic.id);
      } catch (error) {
        console.error(`Failed to update metrics for topic ${topic.id}:`, error);
        // Continue with other topics
      }
    }
    
    console.log('Bulk topic metrics update complete');
  }
  
  /**
   * Record time series data point
   * Called hourly to capture historical data for charting
   * 
   * @param db - D1 database instance
   * @param topicId - Topic ID
   */
  static async recordTimeSeriesData(
    db: any,
    topicId: number
  ): Promise<void> {
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);
    
    // Round timestamp to nearest hour
    const timestamp = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
    
    // Count questions and answers in the last hour
    const data = await db.prepare(`
      SELECT 
        COUNT(DISTINCT q.id) as questions_count,
        COALESCE(SUM(q.pub_answers + q.priv_answers), 0) as answers_count,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as likes_count,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as recasts_count
      FROM QueryTopics qt
      INNER JOIN queries q ON qt.query_id = q.id
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash AND fr.created_at >= ?
      WHERE qt.topic_id = ? AND q.created_at >= ?
    `).bind(hourAgo, topicId, hourAgo).first();
    
    // Insert or update time series data
    await db.prepare(`
      INSERT INTO topic_time_series (
        topic_id, timestamp, questions_count, answers_count, likes_count, recasts_count
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id, timestamp) DO UPDATE SET
        questions_count = excluded.questions_count,
        answers_count = excluded.answers_count,
        likes_count = excluded.likes_count,
        recasts_count = excluded.recasts_count
    `).bind(
      topicId,
      timestamp,
      data?.questions_count || 0,
      data?.answers_count || 0,
      data?.likes_count || 0,
      data?.recasts_count || 0
    ).run();
  }
  
  /**
   * Calculate momentum score
   * Composite metric for "trending" ranking
   * 
   * @param metrics - Input metrics for calculation
   * @returns Momentum score (0-100)
   */
  static calculateMomentumScore(metrics: {
    questions_24h: number;
    growth_rate_7d: number;
    engagement_rate: number;
    avg_answers_per_question: number;
  }): number {
    const velocityWeight = 0.4;
    const growthWeight = 0.3;
    const engagementWeight = 0.3;
    
    // Velocity score: normalize questions/day to 0-100 scale
    // Assume 10+ questions/day is max velocity
    const velocityScore = Math.min(metrics.questions_24h / 10, 1) * 100;
    
    // Growth score: normalize % growth to 0-100 scale
    // Assume 100% growth is max, can be negative
    const growthScore = Math.max(0, Math.min(metrics.growth_rate_7d / 100, 1)) * 100;
    
    // Engagement score: normalize engagement rate
    // Assume 10+ engagements per question is max
    const engagementScore = Math.min(metrics.engagement_rate / 10, 1) * 100;
    
    // Weighted combination
    const momentum = (
      velocityScore * velocityWeight +
      growthScore * growthWeight +
      engagementScore * engagementWeight
    );
    
    return Math.round(momentum * 100) / 100; // Round to 2 decimal places
  }
  
  /**
   * Update topic relations based on co-occurrence
   * Finds topics that appear together on questions
   * 
   * @param db - D1 database instance
   */
  static async updateTopicRelations(
    db: any
  ): Promise<void> {
    console.log('Updating topic relations (co-occurrence)');
    
    // Find all pairs of topics that appear together on questions
    const { results: coOccurrences } = await db.prepare(`
      SELECT 
        qt1.topic_id as topic_id_1,
        qt2.topic_id as topic_id_2,
        COUNT(DISTINCT qt1.query_id) as co_occurrence_count
      FROM QueryTopics qt1
      INNER JOIN QueryTopics qt2 ON qt1.query_id = qt2.query_id AND qt1.topic_id < qt2.topic_id
      GROUP BY qt1.topic_id, qt2.topic_id
      HAVING co_occurrence_count > 0
    `).all();
    
    // Update or insert each relation
    for (const relation of coOccurrences) {
      await db.prepare(`
        INSERT INTO topic_relations (topic_id_1, topic_id_2, co_occurrence_count)
        VALUES (?, ?, ?)
        ON CONFLICT(topic_id_1, topic_id_2) DO UPDATE SET
          co_occurrence_count = excluded.co_occurrence_count
      `).bind(
        relation.topic_id_1,
        relation.topic_id_2,
        relation.co_occurrence_count
      ).run();
    }
    
    console.log(`Updated ${coOccurrences.length} topic relations`);
  }
  
  /**
   * Get trending topics
   * 
   * @param db - D1 database instance
   * @param timeWindow - Time window for trending calculation
   * @param limit - Maximum number of results
   * @returns Array of trending topics with metrics
   */
  static async getTrendingTopics(
    db: any,
    timeWindow: '24h' | '7d' | '30d' = '7d',
    limit: number = 10
  ): Promise<TopicWithMetrics[]> {
    // Build WHERE clause based on time window
    let whereClause = '';
    switch (timeWindow) {
      case '24h':
        whereClause = 'WHERE tm.questions_24h > 0';
        break;
      case '7d':
        whereClause = 'WHERE tm.questions_7d > 0';
        break;
      case '30d':
        whereClause = 'WHERE tm.questions_30d > 0';
        break;
    }
    
    const { results } = await db.prepare(`
      SELECT t.*, tm.*
      FROM Topics t
      INNER JOIN topic_metrics tm ON t.id = tm.topic_id
      ${whereClause}
      ORDER BY tm.momentum_score DESC
      LIMIT ?
    `).bind(limit).all();
    
    return results as TopicWithMetrics[];
  }
  
  /**
   * Get time series data for a topic
   * Used for charting
   * 
   * @param db - D1 database instance
   * @param topicId - Topic ID
   * @param timeWindow - Time window for data
   * @returns Array of time series points
   */
  static async getTopicTimeSeries(
    db: any,
    topicId: number,
    timeWindow: '24h' | '7d' | '30d' = '7d'
  ): Promise<TimeSeriesPoint[]> {
    const now = Date.now();
    let timestampThreshold: number;
    
    switch (timeWindow) {
      case '24h':
        timestampThreshold = now - (24 * 60 * 60 * 1000);
        break;
      case '7d':
        timestampThreshold = now - (7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        timestampThreshold = now - (30 * 24 * 60 * 60 * 1000);
        break;
    }
    
    const { results } = await db.prepare(`
      SELECT 
        timestamp,
        questions_count,
        answers_count,
        likes_count,
        recasts_count
      FROM topic_time_series
      WHERE topic_id = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `).bind(topicId, timestampThreshold).all();
    
    return results as TimeSeriesPoint[];
  }
}

