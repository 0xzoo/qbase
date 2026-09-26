// Durable Object exports
export { QAgent } from './agents/QAgent';
export { RateLimitDO } from './agents/RateLimitDO';
export { OracleAgent } from './agents/OracleAgent';

// Route imports
import { handleMetaRoutes } from './routes/meta';
import { handleSnapRoutes } from './routes/snap';
import { handleOGRoutes } from './routes/og';
import { handleAuthRoutes } from './routes/auth';
import { handleAccountRoutes } from './routes/account';
import { handleAdminRoutes } from './routes/admin';
import { handleUserRoutes } from './routes/users';
import { handleFollowRoutes } from './routes/follows';
import { handleFarcasterRoutes } from './routes/farcaster';
import { handleAnswerRoutes } from './routes/answers';
import { handleQueriesRoutes } from './routes/queries';
import { handlePollsRoutes } from './routes/polls';
import { handleArchiveRoutes } from './routes/archive';
import { nameOpenWaveQuestions, sweepClosedWaves } from './services/archive/WaveCommitJob';
import { handleCouncilRoutes } from './routes/council';
import { handleTopicRoutes } from './routes/topics';
import { handleSimilarityRoutes } from './routes/similarity';
import { handleMiniappRoutes } from './routes/miniapp';
import { handlePointsRoutes } from './routes/points';
import { handleSettingsRoutes } from './routes/settings';
import { handleQAgentRoutes } from './routes/qagent';
import { handleTaxonomyRoutes } from './routes/taxonomy';
import { handleWebhookRoutes } from './routes/webhooks';
import { handleBartletApi } from './routes/bartlet';
import { handleQuizCompletionRoutes } from './routes/quiz-completions';
import { handleMeQuizzesRoutes } from './routes/me-quizzes';
import { handleMeQuizAnswersRoutes } from './routes/me-quiz-answers';
import { handleMeAnswersRoutes } from './routes/me-answers';
import { handleAdminQuizStats } from './routes/admin-quiz-stats';
import { buildQuizStats } from './services/quiz/QuizStatsService';
import { handleAdminCastBartlet } from './routes/admin-cast-bartlet';
import { handleAdminRegisterBartletQueries } from './routes/admin-register-bartlet-queries';
import { handleAdminRegisterValuesQueries } from './routes/admin-register-values-queries';
import { handleAdminRegisterApperceptionQueries } from './routes/admin-register-apperception-queries';
import { handleValuesApi } from './routes/values';
import { handleApperceptionApi } from './routes/apperception-api';
import { handleCaSlateApi } from './routes/ca-slate';
import { handleAdminRecastBartletQuestions } from './routes/admin-recast-bartlet-questions';
import { handleAdminSecretMigrate } from './routes/admin-secret-migrate';
import { handleAdminQuizAnswersBackfill } from './routes/admin-quiz-answers-backfill';
import { handleAdminAnonSealMigrate } from './routes/admin-anon-seal-migrate';
import { handleAdminAccountMigrate } from './routes/admin-account-migrate';

// Services for scheduled handler
import { TopicAnalyticsService } from './services/TopicAnalyticsService';
import { runReconciler, runOrphanSweep } from './services/ReconcilerService';
import { reconcileMissingVectors } from './services/VectorReconciler';

// Queue consumers
import { handleAnswerCastBatch, type AnswerCastMessage } from './queues/answerCastConsumer';

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

type Env = any;

/**
 * Inject a `Link: rel="alternate"; type="application/vnd.farcaster.snap+json"`
 * header on snap-typed responses. Non-Warpcast snap clients (e.g. Quorum) use
 * this header for snap discovery and drop the embed entirely when it's absent
 * — even if `Content-Type` already says snap. Idempotent: skips if Link is
 * already set, or if the response isn't snap content-type.
 */
function withSnapLink(response: Response, request: Request): Response {
  const ct = response.headers.get('Content-Type') || '';
  if (!ct.includes('application/vnd.farcaster.snap+json')) return response;
  if (response.headers.has('Link')) return response;
  const u = new URL(request.url);
  const headers = new Headers(response.headers);
  headers.set(
    'Link',
    `<${u.origin}${u.pathname}${u.search}>; rel="alternate"; type="application/vnd.farcaster.snap+json"`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // =========================================================================
    // 0. Snap endpoints — dedicated /snap/* paths (separate from miniapp).
    // /snap/question/:id, /snap/bartlet, etc. No content negotiation needed.
    // See worker/routes/snap.ts.
    // =========================================================================
    let snapResponse;
    try {
      snapResponse = await handleSnapRoutes(request, env, ctx);
    } catch (snapError) {
      console.error('[Worker] handleSnapRoutes threw:', snapError);
      // Fall through to HTML response instead of crashing
      snapResponse = null;
    }
    if (snapResponse) return withSnapLink(snapResponse, request);

    // =========================================================================
    // 1. Meta Tag Injection — MUST be first, before ASSETS
    // Intercepts /quiz/*, /ask/*, /question/*, /questions, /about
    // =========================================================================
    const metaResponse = await handleMetaRoutes(request, env);
    if (metaResponse) return withSnapLink(metaResponse, request);

    // =========================================================================
    // 2. OG Image Generation — /api/og/*
    // =========================================================================
    if (url.pathname.startsWith('/api/og/')) {
      const ogResponse = await handleOGRoutes(request, env);
      if (ogResponse) return ogResponse;
    }

    // =========================================================================
    // 3. API Routes — /api/* and /webhooks/*
    // Each handler returns Response | null (null = no match, fall through)
    // =========================================================================
    // R2 asset serving — must be outside API guard since /r2/* isn't an API path
    // Serves avatars, bartlet sigils, and any other R2-prefixed assets
    if (url.pathname.startsWith('/r2/')) {
      const r = await handleUserRoutes(request, env);
      if (r) return r;
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) {
      // Account sign-in methods + credential linking (docs/specs/account-root.md §6.2)
      if (url.pathname === '/api/auth/methods' || url.pathname.startsWith('/api/auth/siwe/') || url.pathname.startsWith('/api/auth/world/') || url.pathname.startsWith('/api/account/')) {
        const r = await handleAccountRoutes(request, env);
        if (r) return r;
      }
      // Auth routes: /api/auth/*
      if (url.pathname.startsWith('/api/auth/')) {
        const r = await handleAuthRoutes(request, env, ctx);
        if (r) return r;
      }

      // Admin routes: /api/beta/*, /api/admin/beta-whitelist*
      if (url.pathname.startsWith('/api/beta/') || url.pathname.startsWith('/api/admin/beta-whitelist')) {
        const r = await handleAdminRoutes(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/cast-bartlet-questions') {
        const r = await handleAdminCastBartlet(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/register-bartlet-queries') {
        const r = await handleAdminRegisterBartletQueries(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/register-values-queries') {
        const r = await handleAdminRegisterValuesQueries(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/register-apperception-queries') {
        const r = await handleAdminRegisterApperceptionQueries(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/recast-bartlet-questions') {
        const r = await handleAdminRecastBartletQuestions(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/secret-migrate') {
        const r = await handleAdminSecretMigrate(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/quiz-answers-backfill') {
        const r = await handleAdminQuizAnswersBackfill(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/quiz-stats/rebuild') {
        const r = await handleAdminQuizStats(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/anon-seal-migrate') {
        const r = await handleAdminAnonSealMigrate(request, env);
        if (r) return r;
      }
      // Committed wave records (ENS + Arweave): /api/archive/*, /api/admin/archive/*
      if (url.pathname.startsWith('/api/archive/') || url.pathname.startsWith('/api/admin/archive/')) {
        const r = await handleArchiveRoutes(request, env);
        if (r) return r;
      }
      if (url.pathname === '/api/admin/account-migrate') {
        const r = await handleAdminAccountMigrate(request, env);
        if (r) return r;
      }

      // User answers: /api/users/:fid/answers — must be before general /api/users* catch-all
      if (url.pathname.match(/^\/api\/users\/\d+\/answers$/)) {
        const r = await handleAnswerRoutes(request, env);
        if (r) return r;
      }

      // User search: /api/user/search (singular, distinct from /api/users*)
      if (url.pathname === '/api/user/search') {
        const r = await handleUserRoutes(request, env);
        if (r) return r;
      }

      // User routes: /api/users*
      if (url.pathname.startsWith('/api/users')) {
        const r = await handleUserRoutes(request, env);
        if (r) return r;
      }

      // Follow routes: /api/follows*
      if (url.pathname.startsWith('/api/follows')) {
        const r = await handleFollowRoutes(request, env);
        if (r) return r;
      }

      // Farcaster routes: /api/farcaster/*, /api/user/*/avatar, /api/channels/*
      if (url.pathname.startsWith('/api/farcaster/') ||
          url.pathname.match(/^\/api\/user\/\d+\/avatar$/) ||
          url.pathname.startsWith('/api/channels/')) {
        const r = await handleFarcasterRoutes(request, env);
        if (r) return r;
      }

      // Answer routes: /api/answers*
      if (url.pathname.startsWith('/api/answers')) {
        const r = await handleAnswerRoutes(request, env);
        if (r) return r;
      }

      // Poll (wave) routes: /api/polls*
      if (url.pathname.startsWith('/api/polls')) {
        const r = await handlePollsRoutes(request, env);
        if (r) return r;
      }

      // Council routes: /api/council/*, /api/queries/:id/council — before the generic query handler
      if (url.pathname.startsWith('/api/council/') || /^\/api\/queries\/[^/]+\/council$/.test(url.pathname)) {
        const r = await handleCouncilRoutes(request, env);
        if (r) return r;
      }

      // Query routes: /api/queries*
      if (url.pathname.startsWith('/api/queries')) {
        const r = await handleQueriesRoutes(request, env, ctx);
        if (r) return r;
      }

      // Topic routes: /api/topics*, /api/admin/topics/*
      if (url.pathname.startsWith('/api/topics') || url.pathname.startsWith('/api/admin/topics/')) {
        const r = await handleTopicRoutes(request, env);
        if (r) return r;
      }

      // Similarity routes: /api/check-similarity, /api/parse-query
      if (url.pathname === '/api/check-similarity' || url.pathname === '/api/parse-query') {
        const r = await handleSimilarityRoutes(request, env);
        if (r) return r;
      }

      // Bartlet API routes: /api/bartlet/*
      if (url.pathname.startsWith('/api/bartlet/')) {
        const r = await handleBartletApi(request, env);
        if (r) return r;
      }

      // Values API routes: /api/values/*
      if (url.pathname.startsWith('/api/values/')) {
        const r = await handleValuesApi(request, env);
        if (r) return r;
      }

      // Apperception API routes: /api/apperception/*
      if (url.pathname.startsWith('/api/apperception/')) {
        const r = await handleApperceptionApi(request, env);
        if (r) return r;
      }

      // CA slate API routes: /api/ca-slate/*
      if (url.pathname.startsWith('/api/ca-slate/')) {
        const r = await handleCaSlateApi(request, env);
        if (r) return r;
      }

      // Quiz completion routes: /api/quiz-completions*
      if (url.pathname.startsWith('/api/quiz-completions')) {
        const r = await handleQuizCompletionRoutes(request, env);
        if (r) return r;
      }

      // Per-user quiz status (used by /quizzes feed): /api/me/quizzes
      if (url.pathname === '/api/me/quizzes') {
        const r = await handleMeQuizzesRoutes(request, env);
        if (r) return r;
      }
      // Every non-quiz answer of the caller, for /me/answers: /api/me/answers
      if (url.pathname === '/api/me/answers') {
        const r = await handleMeAnswersRoutes(request, env);
        if (r) return r;
      }
      // Quiz answers as rows: visibility + correlation report: /api/me/quiz-answers*, /api/me/quiz-report
      if (url.pathname.startsWith('/api/me/quiz-answers') || url.pathname === '/api/me/quiz-report') {
        const r = await handleMeQuizAnswersRoutes(request, env);
        if (r) return r;
      }

      // Miniapp routes: /api/miniapp/*
      if (url.pathname.startsWith('/api/miniapp/')) {
        const r = await handleMiniappRoutes(request, env);
        if (r) return r;
      }

      // Points routes: /api/points
      if (url.pathname === '/api/points') {
        const r = await handlePointsRoutes(request, env);
        if (r) return r;
      }

      // Settings routes: /api/settings*
      if (url.pathname.startsWith('/api/settings')) {
        const r = await handleSettingsRoutes(request, env);
        if (r) return r;
      }

      // Taxonomy test routes: /api/test/taxonomy-classification*
      if (url.pathname.startsWith('/api/test/taxonomy-classification')) {
        const r = await handleTaxonomyRoutes(request, env);
        if (r) return r;
      }

      // Q Agent routes: /api/q/*
      if (url.pathname.startsWith('/api/q/')) {
        const r = await handleQAgentRoutes(request, env);
        if (r) return r;
      }

      // Webhook routes: /webhooks/*
      if (url.pathname.startsWith('/webhooks/')) {
        const r = await handleWebhookRoutes(request, env);
        if (r) return r;
      }

      // Allowlist routes: /api/allowlists*
      if (url.pathname.startsWith('/api/allowlists')) {
        const { handleAllowlistRoutes } = await import('./handlers/allowlists');
        return handleAllowlistRoutes(request, env);
      }

      // API 404 fallback
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }

    // =========================================================================
    // 4. Static Assets — try ASSETS first, then SPA fallback
    // =========================================================================
    const assetResponse = await env.ASSETS.fetch(request);

    if (assetResponse.status === 200) {
      // Long cache headers for static images
      if (url.pathname.endsWith('.png') || url.pathname.endsWith('.svg') ||
          url.pathname.endsWith('.jpg') || url.pathname.endsWith('.jpeg') ||
          url.pathname.endsWith('.webp') || url.pathname.endsWith('.ico')) {
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers: {
            ...Object.fromEntries(assetResponse.headers),
            'Cache-Control': 'public, max-age=604800, immutable'
          }
        });
      }
      return assetResponse;
    }

    // SPA fallback: serve index.html for client-side routes
    const indexRequest = new Request(new URL('/index.html', url.origin), {
      method: 'GET',
      headers: request.headers
    });
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.ok) {
      return new Response(indexResponse.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': 'public, max-age=0, must-revalidate'
        }
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * Scheduled handler for cron jobs.
   *
   * Three cadences:
   *   - slash-2 (every 2 min) → Hypersnap reconciler (Phase 2)
   *   - 0 * * * * (hourly) → orphan sweep
   *   - 0 0/8 * * * (3x/day) → topic metrics + Q agent analysis
   *
   * All fire independently based on event.cron.
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cronExpr = event.cron;
    console.log(`[Cron] Fired at ${new Date().toISOString()} (expr: ${cronExpr})`);

    // ── Reconciler (every 2 min) ──
    if (cronExpr === '*/2 * * * *') {
      try {
        console.log('[Reconciler] Starting pass...');
        const start = Date.now();
        const stats = await runReconciler(env);
        console.log(
          `[Reconciler] Done in ${Date.now() - start}ms — ` +
          `processed=${stats.processed} reconciled=${stats.reconciled} flagged=${stats.flagged} ` +
          `deleted=${stats.deleted} errors=${stats.errors}`,
        );
      } catch (err) {
        console.error('[Reconciler] Pass failed:', err);
      }
    }

    // ── Wave archive (every 10 min, staging only: wrangler.dev.jsonc) ──
    // Commits closed waves to ENS + Arweave; a no-op unless ENS_WRITES_ENABLED = "1" and ARCHIVE_SINCE is set.
    if (cronExpr === '*/10 * * * *') {
      try {
        const archiveEnv = env as unknown as Parameters<typeof sweepClosedWaves>[0];
        const named = await nameOpenWaveQuestions(archiveEnv);
        if (named.some((n) => n.status !== 'named')) console.log('[Archive] naming:', JSON.stringify(named));
        const results = await sweepClosedWaves(archiveEnv);
        if (results.length) console.log('[Archive] sweep:', JSON.stringify(results));
      } catch (err) {
        console.error('[Archive] sweep failed:', err);
      }
    }

    // ── Orphan sweep (hourly) ──
    if (cronExpr === '0 * * * *') {
      try {
        console.log('[OrphanSweep] Starting sweep...');
        const result = await runOrphanSweep(env);
        if (result.stale > 0) {
          console.warn(
            `[OrphanSweep] ALERT: ${result.stale} stale unreconciled rows found:\n` +
            result.rows.map(r =>
              `  ${r.cast_hash.slice(0, 12)}... question=${r.question_id ?? 'null'} author=${r.author_fid} age=${r.age_min}min`
            ).join('\n'),
          );
        } else {
          console.log('[OrphanSweep] Clean — no stale rows.');
        }
      } catch (err) {
        console.error('[OrphanSweep] Sweep failed:', err);
      }

      try {
        const vstats = await reconcileMissingVectors(env);
        if (vstats.missing > 0 || vstats.errors > 0) {
          console.warn(
            `[VectorReconciler] scanned=${vstats.scanned} missing=${vstats.missing} ` +
            `reindexed=${vstats.reindexed} errors=${vstats.errors}`,
          );
        } else {
          console.log(`[VectorReconciler] Clean — scanned ${vstats.scanned} recent queries.`);
        }
      } catch (err) {
        console.error('[VectorReconciler] Pass failed:', err);
      }
    }

    // ── Daily topic metrics + Q agent analysis (every 8h) ──
    if (cronExpr === '0 0/8 * * *') {
      try {
        // Update topic metrics
        // Quiz correlation aggregate (worker/services/quiz/QuizStatsService.ts): counts only.
        try {
          const qsStart = Date.now();
          const qs = await buildQuizStats(env);
          console.log(`[Cron] Quiz stats rebuilt in ${Date.now() - qsStart}ms — users=${qs.users} findings=${qs.findings.length}`);
        } catch (err) {
          console.error('[Cron] Quiz stats rebuild failed:', err);
        }

        console.log('[Cron] Starting topic metrics update...');
        const metricsStart = Date.now();
        await TopicAnalyticsService.updateAllTopicMetrics(env.DB);
        console.log(`[Cron] Topic metrics updated in ${Date.now() - metricsStart}ms`);

        // Update topic relations (co-occurrence)
        console.log('[Cron] Starting topic relations update...');
        const relationsStart = Date.now();
        await TopicAnalyticsService.updateTopicRelations(env.DB);
        console.log(`[Cron] Topic relations updated in ${Date.now() - relationsStart}ms`);

        // Record time series data for all topics
        console.log('[Cron] Recording time series data...');
        const timeseriesStart = Date.now();
        const { results: topics } = await env.DB.prepare('SELECT id FROM Topics').all();
        for (const topic of topics) {
          await TopicAnalyticsService.recordTimeSeriesData(env.DB, topic.id as number);
        }
        console.log(`[Cron] Time series data recorded for ${topics.length} topics in ${Date.now() - timeseriesStart}ms`);

        console.log('[Cron] Scheduled job completed successfully');

        // Q's Proactive Analysis Loop
        console.log('[Cron] Waking Q for daily analysis...');
        try {
          const qId = env.QGENT.idFromName("Q");
          const qStub = env.QGENT.get(qId);
          const analyzeRequest = new Request("https://internal/analyze", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.QGENT_ADMIN_SECRET}`,
              "Content-Type": "application/json",
            },
          });
          const qResult = await qStub.fetch(analyzeRequest);
          const qData = await qResult.json() as Record<string, unknown>;
          console.log(`[Cron] Q analysis result:`, JSON.stringify(qData));
        } catch (qError) {
          console.error('[Cron] Q analysis failed:', qError);
        }

      } catch (error) {
        console.error('[Cron] Daily scheduled job failed:', error);
      }
    }

  },

  /**
   * Queue consumer — fans out by queue name.
   * Configured in wrangler.jsonc under `queues.consumers`.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (batch.queue) {
      case 'qbase-answer-casts':
        await handleAnswerCastBatch(batch as MessageBatch<AnswerCastMessage>, env);
        return;
      default:
        console.warn(`[Queue] unknown queue: ${batch.queue}`);
    }
  },
} satisfies ExportedHandler<Env>;
