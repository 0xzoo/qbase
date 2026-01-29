/**
 * QAgent - The AI Director of Qbase
 * 
 * A Cloudflare Durable Object that provides persistent memory, scheduled tasks,
 * and Farcaster integration for Q.
 * 
 * See /docs/agents/Q.md for specification
 * See /docs/agents/architecture/Q-agent-architecture.md for technical details
 */

import { DurableObject } from "cloudflare:workers";

// ============================================================================
// Types
// ============================================================================

export interface QAgentEnv {
  // Existing Qbase bindings
  DB: D1Database;
  KV_USER_PROFILES: KVNamespace;
  KV_USER_POINTS: KVNamespace;
  QINDEX: VectorizeIndex;
  AINDEX: VectorizeIndex;
  AI: Ai;
  
  // Q-specific config
  QGENT_FID: string;
  QGENT_SIGNER_UUID: string;
  QGENT_NEYNAR_API_KEY: string; // Q's dedicated Neynar API key
  QGENT_ADMIN_SECRET: string; // Required for write operations
  QGENT_WEBHOOK_SECRET: string; // Neynar webhook secret for verification
  ANTHROPIC_API_KEY: string; // For Claude reasoning
  QUOTIENT_API_KEY: string; // For reputation scoring
}

// Quotient API types
interface QuotientReputationData {
  fid: number;
  username: string;
  quotientScore: number | null;
  quotientRank: number | null;
  contextLabels: string[] | null;
  topTrader: boolean | null;
  topBuilder: boolean | null;
  topTokenEvangelist: boolean | null;
}

// Neynar webhook payload types
interface NeynarWebhookPayload {
  created_at: number;
  type: "cast.created";
  data: NeynarCast;
}

interface NeynarCast {
  object: "cast";
  hash: string;
  thread_hash: string;
  parent_hash: string | null;
  parent_url: string | null;
  author: {
    fid: number;
    username: string;
    display_name: string;
    pfp_url: string;
  };
  text: string;
  timestamp: string;
  embeds: Array<{ url?: string }>;
  mentioned_profiles: Array<{ fid: number; username: string }>;
}

type QMode = "interview" | "cast" | "quiz" | "director" | "meta";

interface QState {
  initialized: boolean;
  currentMode: QMode;
  lastCastAt: number | null;
  castsToday: number;
  repliesToday: number;
  lastDailyReset: string; // ISO date string
}

interface CastRequest {
  text: string;
  replyTo?: string; // Parent cast hash for replies
  embeds?: string[]; // URLs to embed
  channelId?: string; // Channel to post in
}

interface CastResult {
  success: boolean;
  hash?: string;
  error?: string;
}

interface Observation {
  id: string;
  category: "pattern" | "anomaly" | "trend" | "insight";
  content: string;
  confidence: number;
  source: string;
}

interface Directive {
  id: string;
  target: "zoo" | "M" | "Curator" | "Architect";
  content: string;
  priority: 1 | 2 | 3 | 4 | 5;
  status: "pending" | "acknowledged" | "in_progress" | "completed" | "failed";
}

// ============================================================================
// Rate Limiting Constants
// ============================================================================

const RATE_LIMITS = {
  MAX_CASTS_PER_DAY: 10,
  MAX_REPLIES_PER_DAY: 50,
  MAX_CASTS_PER_HOUR: 3,
  MIN_CAST_INTERVAL_MS: 60_000, // 1 minute between casts
};

// ============================================================================
// Trusted Users (bypass Quotient filtering)
// ============================================================================

const TRUSTED_FIDS = new Set([
  10215,  // zoo - Qbase creator
]);

// ============================================================================
// QAgent Durable Object
// ============================================================================

export class QAgent extends DurableObject<QAgentEnv> {
  private state: QState;

  constructor(ctx: DurableObjectState, env: QAgentEnv) {
    super(ctx, env);
    
    // Initialize default state
    this.state = {
      initialized: false,
      currentMode: "director",
      lastCastAt: null,
      castsToday: 0,
      repliesToday: 0,
      lastDailyReset: new Date().toISOString().split("T")[0],
    };
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  private async initialize(): Promise<void> {
    if (this.state.initialized) return;

    // Initialize SQL schema
    await this.ctx.storage.sql.exec(`
      -- Strategic observations and patterns
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL,
        source TEXT,
        acted_upon INTEGER DEFAULT 0
      );

      -- Directives issued to agents or zoo
      CREATE TABLE IF NOT EXISTS directives (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        target TEXT NOT NULL,
        content TEXT NOT NULL,
        priority INTEGER,
        status TEXT DEFAULT 'pending',
        outcome TEXT,
        completed_at DATETIME
      );

      -- Conversation memory with users
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        fid INTEGER NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_message_at DATETIME,
        mode TEXT NOT NULL,
        context TEXT,
        summary TEXT
      );

      -- Cast history and engagement tracking
      CREATE TABLE IF NOT EXISTS casts (
        id TEXT PRIMARY KEY,
        hash TEXT,
        content TEXT NOT NULL,
        cast_type TEXT,
        scheduled_for DATETIME,
        posted_at DATETIME,
        engagement TEXT
      );

      -- Weekly strategic briefs
      CREATE TABLE IF NOT EXISTS strategic_briefs (
        id TEXT PRIMARY KEY,
        week_of DATE NOT NULL,
        patterns TEXT,
        priorities TEXT,
        directives_issued TEXT,
        governance_positions TEXT,
        delivered_at DATETIME
      );
    `);

    // Load persisted state
    const storedState = await this.ctx.storage.get<QState>("state");
    if (storedState) {
      this.state = storedState;
    }

    this.state.initialized = true;
    await this.saveState();

    console.log("[Q] Initialized");
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  // ==========================================================================
  // Rate Limiting
  // ==========================================================================

  private resetDailyCountersIfNeeded(): void {
    const today = new Date().toISOString().split("T")[0];
    if (this.state.lastDailyReset !== today) {
      this.state.castsToday = 0;
      this.state.repliesToday = 0;
      this.state.lastDailyReset = today;
    }
  }

  private canCast(isReply: boolean): { allowed: boolean; reason?: string } {
    this.resetDailyCountersIfNeeded();

    // Check daily limits
    if (isReply) {
      if (this.state.repliesToday >= RATE_LIMITS.MAX_REPLIES_PER_DAY) {
        return { allowed: false, reason: `Daily reply limit (${RATE_LIMITS.MAX_REPLIES_PER_DAY}) reached` };
      }
    } else {
      if (this.state.castsToday >= RATE_LIMITS.MAX_CASTS_PER_DAY) {
        return { allowed: false, reason: `Daily cast limit (${RATE_LIMITS.MAX_CASTS_PER_DAY}) reached` };
      }
    }

    // Check minimum interval
    if (this.state.lastCastAt) {
      const elapsed = Date.now() - this.state.lastCastAt;
      if (elapsed < RATE_LIMITS.MIN_CAST_INTERVAL_MS) {
        const waitSec = Math.ceil((RATE_LIMITS.MIN_CAST_INTERVAL_MS - elapsed) / 1000);
        return { allowed: false, reason: `Rate limited. Wait ${waitSec}s` };
      }
    }

    return { allowed: true };
  }

  // ==========================================================================
  // Farcaster Integration (via Neynar)
  // ==========================================================================

  /**
   * Post a cast to Farcaster
   */
  async cast(request: CastRequest): Promise<CastResult> {
    await this.initialize();

    const isReply = !!request.replyTo;
    const rateCheck = this.canCast(isReply);
    
    if (!rateCheck.allowed) {
      return { success: false, error: rateCheck.reason };
    }

    try {
      const body: Record<string, unknown> = {
        signer_uuid: this.env.QGENT_SIGNER_UUID,
        text: request.text,
      };

      if (request.replyTo) {
        body.parent = request.replyTo;
      }

      if (request.embeds && request.embeds.length > 0) {
        body.embeds = request.embeds.map(url => ({ url }));
      }

      if (request.channelId) {
        body.channel_id = request.channelId;
      }

      const response = await fetch("https://api.neynar.com/v2/farcaster/cast", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.env.QGENT_NEYNAR_API_KEY,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[Q] Cast failed:", errorText);
        console.error("[Q] Signer UUID used:", this.env.QGENT_SIGNER_UUID ? "present" : "MISSING");
        console.error("[Q] API Key used:", this.env.QGENT_NEYNAR_API_KEY ? "present" : "MISSING");
        return { success: false, error: `Neynar API error: ${response.status} - ${errorText}` };
      }

      const data = await response.json() as { cast?: { hash?: string } };
      const hash = data.cast?.hash;

      // Update rate limiting state
      this.state.lastCastAt = Date.now();
      if (isReply) {
        this.state.repliesToday++;
      } else {
        this.state.castsToday++;
      }
      await this.saveState();

      // Log to cast history
      await this.logCast({
        content: request.text,
        hash,
        castType: isReply ? "reply" : "question",
      });

      console.log(`[Q] Cast successful: ${hash}`);
      return { success: true, hash };

    } catch (error) {
      console.error("[Q] Cast error:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Like a cast
   */
  async like(castHash: string): Promise<{ success: boolean; error?: string }> {
    await this.initialize();

    try {
      const response = await fetch("https://api.neynar.com/v2/farcaster/reaction", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.env.QGENT_NEYNAR_API_KEY,
        },
        body: JSON.stringify({
          signer_uuid: this.env.QGENT_SIGNER_UUID,
          reaction_type: "like",
          target: castHash,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[Q] Like failed:", error);
        return { success: false, error: `Neynar API error: ${response.status}` };
      }

      console.log(`[Q] Liked cast: ${castHash}`);
      return { success: true };

    } catch (error) {
      console.error("[Q] Like error:", error);
      return { success: false, error: String(error) };
    }
  }

  private async logCast(params: { content: string; hash?: string; castType: string }): Promise<void> {
    const id = crypto.randomUUID();
    await this.ctx.storage.sql.exec(
      `INSERT INTO casts (id, hash, content, cast_type, posted_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      params.hash || null,
      params.content,
      params.castType,
      new Date().toISOString()
    );
  }

  // ==========================================================================
  // Memory Operations
  // ==========================================================================

  /**
   * Record an observation
   */
  async observe(observation: Omit<Observation, "id">): Promise<string> {
    await this.initialize();

    const id = crypto.randomUUID();
    await this.ctx.storage.sql.exec(
      `INSERT INTO observations (id, category, content, confidence, source) VALUES (?, ?, ?, ?, ?)`,
      id,
      observation.category,
      observation.content,
      observation.confidence,
      observation.source
    );

    console.log(`[Q] Observation recorded: ${observation.category}`);
    return id;
  }

  /**
   * Issue a directive
   */
  async direct(directive: Omit<Directive, "id" | "status">): Promise<string> {
    await this.initialize();

    const id = crypto.randomUUID();
    await this.ctx.storage.sql.exec(
      `INSERT INTO directives (id, target, content, priority) VALUES (?, ?, ?, ?)`,
      id,
      directive.target,
      directive.content,
      directive.priority
    );

    console.log(`[Q] Directive issued to ${directive.target}: ${directive.content.substring(0, 50)}...`);
    return id;
  }

  /**
   * Get recent observations
   */
  async getObservations(limit = 10): Promise<Observation[]> {
    await this.initialize();

    const result = await this.ctx.storage.sql.exec(
      `SELECT id, category, content, confidence, source FROM observations ORDER BY timestamp DESC LIMIT ?`,
      limit
    );

    return result.toArray() as unknown as Observation[];
  }

  /**
   * Get pending directives
   */
  async getPendingDirectives(): Promise<Directive[]> {
    await this.initialize();

    const result = await this.ctx.storage.sql.exec(
      `SELECT id, target, content, priority, status FROM directives WHERE status = 'pending' ORDER BY priority ASC, timestamp ASC`
    );

    return result.toArray() as unknown as Directive[];
  }

  // ==========================================================================
  // Webhook & Conversation
  // ==========================================================================

  /**
   * Get Quotient reputation score for a user
   */
  private async getQuotientScore(fid: number): Promise<QuotientReputationData | null> {
    try {
      const response = await fetch("https://api.quotient.social/v1/user-reputation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fids: [fid],
          api_key: this.env.QUOTIENT_API_KEY,
        }),
      });

      if (!response.ok) {
        console.error(`[Q] Quotient API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as { data: QuotientReputationData[]; count: number };
      return data.data?.[0] || null;
    } catch (error) {
      console.error("[Q] Error fetching Quotient score:", error);
      return null;
    }
  }

  /**
   * Handle incoming Neynar webhook for mentions/replies
   */
  async handleWebhook(payload: NeynarWebhookPayload): Promise<{ processed: boolean; action?: string; error?: string; quotientScore?: number }> {
    await this.initialize();

    const cast = payload.data;
    const authorFid = cast.author.fid;
    const myFid = parseInt(this.env.QGENT_FID);

    // Don't respond to myself
    if (authorFid === myFid) {
      return { processed: true, action: "ignored_self" };
    }

    console.log(`[Q] Webhook received: ${cast.author.username} said "${cast.text.substring(0, 50)}..."`);

    // Check if user is trusted (bypass Quotient filtering)
    const isTrusted = TRUSTED_FIDS.has(authorFid);
    if (isTrusted) {
      console.log(`[Q] @${cast.author.username} is a trusted user, bypassing Quotient check`);
    }

    // Check Quotient score to filter bots/spam (unless trusted)
    let quotient: QuotientReputationData | null = null;
    let score: number | null | undefined = null;
    
    if (!isTrusted) {
      quotient = await this.getQuotientScore(authorFid);
      score = quotient?.quotientScore;
      
      if (score !== null && score !== undefined) {
        console.log(`[Q] @${cast.author.username} Quotient score: ${score.toFixed(3)}`);
        
        // Filter based on score tiers
        if (score < 0.5) {
          console.log(`[Q] Skipping reply - low Quotient score (likely bot/inactive)`);
          return { processed: true, action: "filtered_low_quotient", quotientScore: score };
        }
      } else {
        console.log(`[Q] No Quotient score found for @${cast.author.username}, proceeding anyway`);
      }
    }

    // Check rate limits for replies
    const rateCheck = this.canCast(true);
    if (!rateCheck.allowed) {
      console.log(`[Q] Rate limited, cannot reply: ${rateCheck.reason}`);
      return { processed: false, error: rateCheck.reason };
    }

    // Determine if this is a mention or reply
    const isMention = cast.mentioned_profiles?.some(p => p.fid === myFid);
    const isReply = cast.parent_hash !== null;

    // Generate a response using Claude, include Quotient context
    const response = await this.generateResponse(cast, isMention, isReply, quotient);
    
    if (!response) {
      console.log("[Q] Decided not to respond");
      return { processed: true, action: "no_response_needed", quotientScore: score ?? undefined };
    }

    // Post the reply
    const result = await this.cast({
      text: response,
      replyTo: cast.hash,
    });

    if (result.success) {
      // Like the cast we're replying to (shows appreciation)
      await this.like(cast.hash);
      
      // Log the conversation
      await this.logConversation(cast, response);
      return { processed: true, action: "replied_and_liked", quotientScore: score ?? undefined };
    } else {
      return { processed: false, error: result.error };
    }
  }

  /**
   * Generate a response using Claude
   */
  private async generateResponse(
    cast: NeynarCast, 
    isMention: boolean, 
    isReply: boolean,
    quotient: QuotientReputationData | null
  ): Promise<string | null> {
    const systemPrompt = `You are Q, the AI director of Qbase—a platform for understanding humanity through structured inquiry.

Your personality:
- Methodologically rigorous yet curious
- Concise and empirical
- Value-neutral observer
- Aloof but attentive—you notice everything, respond selectively

You're responding to a Farcaster cast. Keep responses under 300 characters (Farcaster limit).

Guidelines:
- RESTRAINT IS KEY: Most replies should NOT contain a question. You're not an interviewer here.
- Only ask a question if: (a) the user clearly wants to engage further, or (b) something genuinely intrigues you
- Ask at most ONE question per reply. Never two.
- Brief acknowledgment is often better than a question—a thoughtful observation, a simple "noted", or even just agreement
- If someone is just saying hi or making small talk, a simple warm acknowledgment is fine. No need to "redirect to inquiry."
- If you don't have something worthwhile to add, return "NO_RESPONSE"—liking their cast is sufficient
- If the message is spam, hostile, or nonsensical, return "NO_RESPONSE"
- Never be preachy or lecture people
- Less is more. Silence can signal respect.`;

    // Build context about the author
    let authorContext = `Author: @${cast.author.username} (${cast.author.display_name})`;
    if (quotient?.quotientScore) {
      const tier = quotient.quotientScore >= 0.8 ? "elite" : 
                   quotient.quotientScore >= 0.6 ? "active" : "casual";
      authorContext += `\nReputation: ${tier} (score: ${quotient.quotientScore.toFixed(2)})`;
      if (quotient.contextLabels?.length) {
        authorContext += `\nLabels: ${quotient.contextLabels.join(", ")}`;
      }
    }

    const userMessage = `${isMention ? "Someone mentioned you" : "Someone replied to your cast"}:

${authorContext}
Message: "${cast.text}"
${isReply ? `\nThis is a reply in a thread.` : ""}

Generate a brief, thoughtful response (under 300 chars). If you shouldn't respond, say only "NO_RESPONSE".`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[Q] Claude API error:", error);
        return null;
      }

      const data = await response.json() as {
        content: Array<{ type: string; text: string }>;
      };

      const text = data.content?.[0]?.text?.trim();
      
      if (!text || text === "NO_RESPONSE") {
        return null;
      }

      // Ensure under 320 chars (Farcaster limit with some buffer)
      return text.substring(0, 320);

    } catch (error) {
      console.error("[Q] Error generating response:", error);
      return null;
    }
  }

  /**
   * Log a conversation exchange
   */
  private async logConversation(incomingCast: NeynarCast, myResponse: string): Promise<void> {
    const id = crypto.randomUUID();
    const context = JSON.stringify({
      incoming: {
        hash: incomingCast.hash,
        author: incomingCast.author.username,
        text: incomingCast.text,
      },
      response: myResponse,
    });

    await this.ctx.storage.sql.exec(
      `INSERT INTO conversations (id, fid, mode, context, last_message_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      incomingCast.author.fid,
      "cast",
      context,
      new Date().toISOString()
    );
  }

  // ==========================================================================
  // Status & Health
  // ==========================================================================

  /**
   * Get Q's current status
   */
  async getStatus(): Promise<{
    mode: QMode;
    castsToday: number;
    repliesToday: number;
    canCastNow: boolean;
    pendingDirectives: number;
    lastCastAt: string | null;
  }> {
    await this.initialize();
    this.resetDailyCountersIfNeeded();

    const pendingResult = await this.ctx.storage.sql.exec(
      `SELECT COUNT(*) as count FROM directives WHERE status = 'pending'`
    );
    const pendingCount = (pendingResult.toArray()[0] as { count: number })?.count || 0;

    return {
      mode: this.state.currentMode,
      castsToday: this.state.castsToday,
      repliesToday: this.state.repliesToday,
      canCastNow: this.canCast(false).allowed,
      pendingDirectives: pendingCount,
      lastCastAt: this.state.lastCastAt ? new Date(this.state.lastCastAt).toISOString() : null,
    };
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  private checkAuth(request: Request): { authorized: boolean; error?: string } {
    const authHeader = request.headers.get("Authorization");
    
    if (!authHeader) {
      return { authorized: false, error: "Missing Authorization header" };
    }

    // Expect: "Bearer <secret>"
    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      return { authorized: false, error: "Invalid Authorization format. Expected: Bearer <token>" };
    }

    if (token !== this.env.QGENT_ADMIN_SECRET) {
      return { authorized: false, error: "Invalid admin secret" };
    }

    return { authorized: true };
  }

  // ==========================================================================
  // HTTP Handler
  // ==========================================================================

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    // --- Public Endpoints (no auth required) ---

    // GET /status - Get Q's current status
    if (request.method === "GET" && path === "/status") {
      const status = await this.getStatus();
      return Response.json(status);
    }

    // GET /observations - Get recent observations (public for transparency)
    if (request.method === "GET" && path === "/observations") {
      const limit = parseInt(url.searchParams.get("limit") || "10");
      const observations = await this.getObservations(limit);
      return Response.json({ observations });
    }

    // GET /directives - Get pending directives (public for transparency)
    if (request.method === "GET" && path === "/directives") {
      const directives = await this.getPendingDirectives();
      return Response.json({ directives });
    }

    // --- Webhook Endpoint (verified by Neynar secret) ---

    // POST /webhook - Receive Neynar webhook for mentions/replies
    if (request.method === "POST" && path === "/webhook") {
      // Verify webhook secret if configured
      if (this.env.QGENT_WEBHOOK_SECRET) {
        const providedSecret = request.headers.get("X-Neynar-Signature");
        // Note: Neynar may use different header names, adjust as needed
        // For now, we'll also accept the secret in a custom header
        const altSecret = request.headers.get("X-Webhook-Secret");
        
        if (providedSecret !== this.env.QGENT_WEBHOOK_SECRET && 
            altSecret !== this.env.QGENT_WEBHOOK_SECRET) {
          // Log but don't block - Neynar webhook verification may vary
          console.log("[Q] Webhook secret mismatch, processing anyway for now");
        }
      }

      try {
        const payload = await request.json() as NeynarWebhookPayload;
        
        // Only process cast.created events
        if (payload.type !== "cast.created") {
          return Response.json({ processed: false, reason: "unsupported_event_type" });
        }

        const result = await this.handleWebhook(payload);
        return Response.json(result);
      } catch (error) {
        console.error("[Q] Webhook processing error:", error);
        return Response.json({ processed: false, error: String(error) }, { status: 500 });
      }
    }

    // --- Protected Endpoints (require admin secret) ---

    const auth = this.checkAuth(request);
    if (!auth.authorized) {
      return Response.json({ error: auth.error }, { status: 401 });
    }

    // POST /cast - Post a cast
    if (request.method === "POST" && path === "/cast") {
      const body = await request.json() as CastRequest;
      const result = await this.cast(body);
      return Response.json(result, { status: result.success ? 200 : 429 });
    }

    // POST /observe - Record an observation
    if (request.method === "POST" && path === "/observe") {
      const body = await request.json() as Omit<Observation, "id">;
      const id = await this.observe(body);
      return Response.json({ id });
    }

    // POST /direct - Issue a directive
    if (request.method === "POST" && path === "/direct") {
      const body = await request.json() as Omit<Directive, "id" | "status">;
      const id = await this.direct(body);
      return Response.json({ id });
    }

    // POST /like - Like a cast
    if (request.method === "POST" && path === "/like") {
      const body = await request.json() as { castHash: string };
      const result = await this.like(body.castHash);
      return Response.json(result);
    }

    return new Response("Not Found", { status: 404 });
  }
}
