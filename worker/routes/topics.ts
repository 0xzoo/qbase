/**
 * Topics API Routes
 *
 * Handles:
 * - POST /api/admin/topics/backfill - Backfill topics from existing questions' tags (admin only)
 * - POST /api/admin/topics/update-metrics - Manually trigger topic metrics update (admin only)
 * - GET /api/topics/trending - Get trending topics
 * - GET /api/topics/search - Search/autocomplete topics
 * - GET /api/topics/:id/related - Get related topics
 * - GET /api/topics/:id/timeseries - Get time series data for charts
 * - GET /api/topics/:idOrName - Get single topic with metrics (by ID or name)
 * - GET /api/topics - List all topics with metrics
 */

import { TopicService } from '../services/TopicService';
import { TopicAnalyticsService } from '../services/TopicAnalyticsService';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

type Env = any;

/**
 * Handle topic-related API routes
 */
export async function handleTopicRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // POST /api/admin/topics/backfill - Backfill topics from existing questions' tags (admin only)
  if (pathname === "/api/admin/topics/backfill" && request.method === "POST") {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Only admins can trigger backfill
    if (!BetaWhitelistService.isAdmin(auth.fid)) {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    try {
      const body = await request.json() as { batchSize?: number; dryRun?: boolean };
      const batchSize = body.batchSize || 100;
      const dryRun = body.dryRun || false;

      console.log(`[Topics Backfill] Starting backfill (batchSize: ${batchSize}, dryRun: ${dryRun})`);

      // Get all queries with tags
      const { results: queries } = await env.DB.prepare(`
        SELECT id, tags FROM queries WHERE tags IS NOT NULL AND tags != '[]'
      `).all();

      console.log(`[Topics Backfill] Found ${queries.length} queries with tags`);

      let processedCount = 0;
      let topicsCreated = 0;
      let associationsCreated = 0;
      const errors: string[] = [];

      for (let i = 0; i < queries.length; i += batchSize) {
        const batch = queries.slice(i, i + batchSize);

        for (const query of batch) {
          try {
            const tags = JSON.parse(query.tags as string) as string[];

            // Extract topic names from tags (format: "source:topic")
            const topicNames = tags
              .map(tag => {
                const parts = tag.split(':');
                return parts.length >= 2 ? parts.slice(1).join(':').trim() : null;
              })
              .filter((name): name is string => name !== null && name.length > 0);

            if (topicNames.length === 0) continue;

            if (dryRun) {
              console.log(`[Topics Backfill] Would process query ${query.id}: ${topicNames.join(', ')}`);
              processedCount++;
              continue;
            }

            // Get or create topics
            const topics = await TopicService.getOrCreateTopics(env.DB, topicNames);
            topicsCreated += topics.filter(t => t.created_at === Date.now()).length; // Approximate new topics

            // Associate topics with query
            const topicIds = topics.map(t => t.id);
            await TopicService.associateTopicsWithQuery(env.DB, query.id as string, topicIds);
            associationsCreated += topicIds.length;

            processedCount++;
          } catch (queryError) {
            const errMsg = `Query ${query.id}: ${(queryError as Error).message}`;
            errors.push(errMsg);
            console.error(`[Topics Backfill] Error: ${errMsg}`);
          }
        }

        console.log(`[Topics Backfill] Processed ${Math.min(i + batchSize, queries.length)}/${queries.length}`);
      }

      // Update topic metrics for all topics
      if (!dryRun) {
        console.log('[Topics Backfill] Updating topic metrics...');
        await TopicAnalyticsService.updateAllTopicMetrics(env.DB);

        console.log('[Topics Backfill] Updating topic relations...');
        await TopicAnalyticsService.updateTopicRelations(env.DB);
      }

      return Response.json({
        success: true,
        dryRun,
        totalQueries: queries.length,
        processedCount,
        topicsCreated,
        associationsCreated,
        errors: errors.slice(0, 10), // Return first 10 errors
        errorCount: errors.length,
      });
    } catch (error) {
      console.error("[Topics Backfill] Error:", error);
      return Response.json({ error: 'Failed to backfill topics' }, { status: 500 });
    }
  }

  // POST /api/admin/topics/update-metrics - Manually trigger topic metrics update (admin only)
  if (pathname === "/api/admin/topics/update-metrics" && request.method === "POST") {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!BetaWhitelistService.isAdmin(auth.fid)) {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    try {
      console.log('[Topics Admin] Starting metrics update...');
      const startTime = Date.now();

      await TopicAnalyticsService.updateAllTopicMetrics(env.DB);
      await TopicAnalyticsService.updateTopicRelations(env.DB);

      const duration = Date.now() - startTime;
      console.log(`[Topics Admin] Metrics update completed in ${duration}ms`);

      return Response.json({
        success: true,
        durationMs: duration,
      });
    } catch (error) {
      console.error("[Topics Admin] Error updating metrics:", error);
      return Response.json({ error: 'Failed to update topic metrics' }, { status: 500 });
    }
  }

  // Topics endpoints
  if (pathname.startsWith("/api/topics")) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);

    // GET /api/topics/trending - Get trending topics
    if (pathname === "/api/topics/trending" && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:trending');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const timeWindow = (url.searchParams.get('timeWindow') as '24h' | '7d' | '30d') || '7d';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

        const topics = await TopicAnalyticsService.getTrendingTopics(env.DB, timeWindow, limit);
        return Response.json({ topics });
      } catch (error) {
        console.error("Error fetching trending topics:", error);
        return Response.json({ error: 'Failed to fetch trending topics' }, { status: 500 });
      }
    }

    // GET /api/topics/search - Search/autocomplete topics
    if (pathname === "/api/topics/search" && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:search');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const query = url.searchParams.get('q');
        if (!query || query.length < 1) {
          return Response.json({ topics: [] });
        }

        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 20);
        const topics = await TopicService.searchTopics(env.DB, query, limit);
        return Response.json({ topics });
      } catch (error) {
        console.error("Error searching topics:", error);
        return Response.json({ error: 'Failed to search topics' }, { status: 500 });
      }
    }

    // GET /api/topics/:id/related - Get related topics
    const relatedMatch = pathname.match(/^\/api\/topics\/(\d+)\/related$/);
    if (relatedMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:related');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const topicId = parseInt(relatedMatch[1], 10);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '5'), 20);

        const relatedTopics = await TopicService.getRelatedTopics(env.DB, topicId, limit);
        return Response.json({ topics: relatedTopics });
      } catch (error) {
        console.error("Error fetching related topics:", error);
        return Response.json({ error: 'Failed to fetch related topics' }, { status: 500 });
      }
    }

    // GET /api/topics/:id/timeseries - Get time series data for charts
    const timeseriesMatch = pathname.match(/^\/api\/topics\/(\d+)\/timeseries$/);
    if (timeseriesMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:timeseries');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const topicId = parseInt(timeseriesMatch[1], 10);
        const timeWindow = (url.searchParams.get('timeWindow') as '24h' | '7d' | '30d') || '7d';

        const timeseries = await TopicAnalyticsService.getTopicTimeSeries(env.DB, topicId, timeWindow);
        return Response.json({ timeseries });
      } catch (error) {
        console.error("Error fetching topic timeseries:", error);
        return Response.json({ error: 'Failed to fetch topic timeseries' }, { status: 500 });
      }
    }

    // GET /api/topics/:idOrName - Get single topic with metrics (by ID or name)
    const topicIdMatch = pathname.match(/^\/api\/topics\/([^/]+)$/);
    if (topicIdMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:get');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const idOrName = topicIdMatch[1];
        // Try to parse as number, otherwise use as name
        const topicIdOrName = /^\d+$/.test(idOrName) ? parseInt(idOrName, 10) : decodeURIComponent(idOrName);

        const topic = await TopicService.getTopicWithMetrics(env.DB, topicIdOrName);

        if (!topic) {
          return Response.json({ error: 'Topic not found' }, { status: 404 });
        }

        return Response.json({ topic });
      } catch (error) {
        console.error("Error fetching topic:", error);
        return Response.json({ error: 'Failed to fetch topic' }, { status: 500 });
      }
    }

    // GET /api/topics - List all topics with metrics
    if (pathname === "/api/topics" && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'topics:list');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const sortBy = (url.searchParams.get('sortBy') as 'momentum' | 'recent' | 'popular' | 'alphabetical') || 'momentum';
        const timeWindow = (url.searchParams.get('timeWindow') as '24h' | '7d' | '30d' | 'all') || '7d';

        const result = await TopicService.listTopics(env.DB, { limit, offset, sortBy, timeWindow });
        return Response.json(result);
      } catch (error) {
        console.error("Error listing topics:", error);
        return Response.json({ error: 'Failed to list topics' }, { status: 500 });
      }
    }
  }

  return null;
}
