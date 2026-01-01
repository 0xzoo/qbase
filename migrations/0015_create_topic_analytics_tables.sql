-- Migration: Create topic analytics tables
-- Date: 2025-01-01
-- Description: Adds tables for topic metrics, time series data, and relations

-- Create topic_metrics table for aggregated analytics
CREATE TABLE IF NOT EXISTS topic_metrics (
  topic_id INTEGER PRIMARY KEY,
  
  -- Volume metrics
  total_questions INTEGER DEFAULT 0,
  total_answers INTEGER DEFAULT 0,
  total_contributors INTEGER DEFAULT 0,
  
  -- Time-windowed metrics
  questions_24h INTEGER DEFAULT 0,
  questions_7d INTEGER DEFAULT 0,
  questions_30d INTEGER DEFAULT 0,
  
  -- Growth rates (stored as percentages, can be negative)
  growth_rate_24h REAL DEFAULT 0,
  growth_rate_7d REAL DEFAULT 0,
  growth_rate_30d REAL DEFAULT 0,
  
  -- Engagement metrics
  avg_answers_per_question REAL DEFAULT 0,
  total_likes INTEGER DEFAULT 0,
  total_recasts INTEGER DEFAULT 0,
  engagement_rate REAL DEFAULT 0,
  
  -- Composite score and trend
  momentum_score REAL DEFAULT 0,
  trend_direction TEXT DEFAULT 'stable' CHECK(trend_direction IN ('rising', 'falling', 'stable')),
  
  -- Timestamps
  last_updated INTEGER NOT NULL,
  
  FOREIGN KEY (topic_id) REFERENCES Topics(id) ON DELETE CASCADE
);

-- Indexes for topic_metrics
CREATE INDEX IF NOT EXISTS idx_topic_metrics_momentum ON topic_metrics(momentum_score DESC);
CREATE INDEX IF NOT EXISTS idx_topic_metrics_questions_24h ON topic_metrics(questions_24h DESC);
CREATE INDEX IF NOT EXISTS idx_topic_metrics_questions_7d ON topic_metrics(questions_7d DESC);
CREATE INDEX IF NOT EXISTS idx_topic_metrics_updated ON topic_metrics(last_updated);
CREATE INDEX IF NOT EXISTS idx_topic_metrics_trend ON topic_metrics(trend_direction);

-- Create topic_time_series table for historical data
CREATE TABLE IF NOT EXISTS topic_time_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL, -- Unix timestamp (hour granularity recommended)
  
  -- Counts for this time period
  questions_count INTEGER DEFAULT 0,
  answers_count INTEGER DEFAULT 0,
  
  -- Engagement for this time period
  likes_count INTEGER DEFAULT 0,
  recasts_count INTEGER DEFAULT 0,
  
  FOREIGN KEY (topic_id) REFERENCES Topics(id) ON DELETE CASCADE,
  UNIQUE(topic_id, timestamp)
);

-- Indexes for topic_time_series
CREATE INDEX IF NOT EXISTS idx_topic_timeseries_topic_time ON topic_time_series(topic_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_topic_timeseries_timestamp ON topic_time_series(timestamp DESC);

-- Create topic_relations table for co-occurrence tracking
CREATE TABLE IF NOT EXISTS topic_relations (
  topic_id_1 INTEGER NOT NULL,
  topic_id_2 INTEGER NOT NULL,
  co_occurrence_count INTEGER DEFAULT 0,
  
  PRIMARY KEY (topic_id_1, topic_id_2),
  FOREIGN KEY (topic_id_1) REFERENCES Topics(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id_2) REFERENCES Topics(id) ON DELETE CASCADE,
  CHECK (topic_id_1 < topic_id_2) -- Ensure ordered pairs to avoid duplicates
);

-- Indexes for topic_relations
CREATE INDEX IF NOT EXISTS idx_topic_relations_topic1 ON topic_relations(topic_id_1, co_occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_topic_relations_topic2 ON topic_relations(topic_id_2, co_occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_topic_relations_count ON topic_relations(co_occurrence_count DESC);

