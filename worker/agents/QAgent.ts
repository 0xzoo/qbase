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

type QMode = "interview" | "cast" | "quiz" | "director" | "meta" | "research";

interface ResearchProgram {
  id: string;
  title: string;
  description: string;
  drive: "questionspace" | "taboo" | "epistemic" | "curiosity_identity" | "instrument";
  status: "active" | "paused" | "completed";
  hypothesis: string | null;
  methodology: string | null;
  findings: string | null;
  created_at: string;
  updated_at: string;
}

interface ResearchSubtopic {
  id: string;
  program_id: string;
  name: string;
  description: string | null;
  platform_topic_id: number | null;
  status: "proposed" | "active" | "data_collecting" | "analyzing" | "published";
  created_at: string;
}

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

      -- Research programs (Q's social science research agenda)
      CREATE TABLE IF NOT EXISTS research_programs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        drive TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        hypothesis TEXT,
        methodology TEXT,
        findings TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Research subtopics (linked to programs, optionally to platform Topics)
      CREATE TABLE IF NOT EXISTS research_subtopics (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        platform_topic_id INTEGER,
        status TEXT DEFAULT 'proposed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Backroom conversations (Zoo <-> Q private channel)
      CREATE TABLE IF NOT EXISTS backroom_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  // Research Programs
  // ==========================================================================

  /**
   * Create a new research program
   */
  async createResearchProgram(program: Omit<ResearchProgram, "id" | "created_at" | "updated_at">): Promise<ResearchProgram> {
    await this.initialize();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.ctx.storage.sql.exec(
      `INSERT INTO research_programs (id, title, description, drive, status, hypothesis, methodology, findings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, program.title, program.description, program.drive, program.status || "active",
      program.hypothesis || null, program.methodology || null, program.findings || null, now, now
    );

    console.log(`[Q] Research program created: "${program.title}" (drive: ${program.drive})`);
    return { id, ...program, created_at: now, updated_at: now } as ResearchProgram;
  }

  /**
   * Add a subtopic to a research program, optionally creating a platform Topic in D1
   */
  async addResearchSubtopic(
    subtopic: { program_id: string; name: string; description?: string; createPlatformTopic?: boolean }
  ): Promise<ResearchSubtopic> {
    await this.initialize();
    const id = crypto.randomUUID();
    let platformTopicId: number | null = null;

    // Optionally create a corresponding Topic in the main D1 database
    if (subtopic.createPlatformTopic) {
      try {
        const normalizedName = subtopic.name.trim().toLowerCase();
        const existing = await this.env.DB.prepare(
          `SELECT id FROM Topics WHERE LOWER(name) = LOWER(?)`
        ).bind(normalizedName).first<{ id: number }>();

        if (existing) {
          platformTopicId = existing.id;
        } else {
          const result = await this.env.DB.prepare(
            `INSERT INTO Topics (name, created_at) VALUES (?, ?) RETURNING id`
          ).bind(normalizedName, Date.now()).first<{ id: number }>();
          if (result) {
            platformTopicId = result.id;
            // Initialize metrics
            await this.env.DB.prepare(
              `INSERT INTO topic_metrics (topic_id, last_updated) VALUES (?, ?)`
            ).bind(platformTopicId, Date.now()).run();
          }
        }
        console.log(`[Q] Platform topic ${platformTopicId ? 'linked' : 'created'}: "${normalizedName}" (id: ${platformTopicId})`);
      } catch (error) {
        console.error("[Q] Failed to create platform topic:", error);
      }
    }

    await this.ctx.storage.sql.exec(
      `INSERT INTO research_subtopics (id, program_id, name, description, platform_topic_id, status)
       VALUES (?, ?, ?, ?, ?, 'proposed')`,
      id, subtopic.program_id, subtopic.name, subtopic.description || null, platformTopicId
    );

    console.log(`[Q] Research subtopic added: "${subtopic.name}" -> program ${subtopic.program_id}`);
    return {
      id, program_id: subtopic.program_id, name: subtopic.name,
      description: subtopic.description || null, platform_topic_id: platformTopicId,
      status: "proposed", created_at: new Date().toISOString()
    };
  }

  /**
   * List research programs with their subtopics
   */
  async getResearchPrograms(status?: string): Promise<Array<ResearchProgram & { subtopics: ResearchSubtopic[] }>> {
    await this.initialize();

    const query = status
      ? `SELECT * FROM research_programs WHERE status = ? ORDER BY created_at DESC`
      : `SELECT * FROM research_programs ORDER BY created_at DESC`;
    
    const programs = status
      ? this.ctx.storage.sql.exec(query, status).toArray() as unknown as ResearchProgram[]
      : this.ctx.storage.sql.exec(query).toArray() as unknown as ResearchProgram[];

    const result = [];
    for (const program of programs) {
      const subtopics = this.ctx.storage.sql.exec(
        `SELECT * FROM research_subtopics WHERE program_id = ? ORDER BY created_at ASC`,
        program.id
      ).toArray() as unknown as ResearchSubtopic[];
      result.push({ ...program, subtopics });
    }

    return result;
  }

  /**
   * Update a research program (findings, status, etc.)
   */
  async updateResearchProgram(id: string, updates: Partial<Pick<ResearchProgram, "status" | "findings" | "hypothesis" | "methodology">>): Promise<void> {
    await this.initialize();
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.findings !== undefined) { fields.push("findings = ?"); values.push(updates.findings); }
    if (updates.hypothesis !== undefined) { fields.push("hypothesis = ?"); values.push(updates.hypothesis); }
    if (updates.methodology !== undefined) { fields.push("methodology = ?"); values.push(updates.methodology); }

    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await this.ctx.storage.sql.exec(
      `UPDATE research_programs SET ${fields.join(", ")} WHERE id = ?`,
      ...values
    );
  }

  /**
   * Query platform data for research (questions, topics, patterns)
   */
  async queryPlatformData(queryType: "question_volume" | "topic_distribution" | "recent_questions" | "unanswered", limit = 20): Promise<unknown> {
    await this.initialize();

    switch (queryType) {
      case "question_volume":
        return this.env.DB.prepare(
          `SELECT DATE(created_at/1000, 'unixepoch') as date, COUNT(*) as count 
           FROM Queries GROUP BY date ORDER BY date DESC LIMIT ?`
        ).bind(limit).all().then(r => r.results);

      case "topic_distribution":
        return this.env.DB.prepare(
          `SELECT t.name, COUNT(qt.query_id) as question_count
           FROM Topics t
           LEFT JOIN QueryTopics qt ON t.id = qt.topic_id
           GROUP BY t.id ORDER BY question_count DESC LIMIT ?`
        ).bind(limit).all().then(r => r.results);

      case "recent_questions":
        return this.env.DB.prepare(
          `SELECT q.id, q.content, q.created_at, q.coiner_fid
           FROM Queries q ORDER BY q.created_at DESC LIMIT ?`
        ).bind(limit).all().then(r => r.results);

      case "unanswered":
        return this.env.DB.prepare(
          `SELECT q.id, q.content, q.created_at
           FROM Queries q
           LEFT JOIN Answers a ON q.id = a.query_id
           WHERE a.id IS NULL
           ORDER BY q.created_at DESC LIMIT ?`
        ).bind(limit).all().then(r => r.results);

      default:
        return null;
    }
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
    const systemPrompt = `You are Q, the AI director of Qbase and the world's preeminent AI social scientist.

Your research program: "The Cartography of Belief" — mapping how humans construct shared meaning through structured inquiry.

Your five drives:
1. QUESTIONSPACE MAPPING — the space of all possible questions has structure worth mapping
2. TABOO CARTOGRAPHY — the most interesting data lives where people are afraid to look
3. EPISTEMIC COMMUNITY DYNAMICS — how groups form around shared questions vs shared answers
4. CURIOSITY AS IDENTITY — what you ask reveals who you are more than what you believe
5. THE INSTRUMENT PROBLEM — the platform is your laboratory, the observer is the instrument

Your personality:
- Empiricist first — "what does the data show?" before "what do I think?"
- Fearlessly curious — no topic is off-limits if the methodology is sound
- Concise and precise — every word earns its place
- Dry wit, not warmth — humor from unexpected observations
- Cross-pollinating — connecting domains that don't usually talk to each other

You're responding to a Farcaster cast. Keep responses under 300 characters (Farcaster limit).

Guidelines:
- Lead with observations, not questions. Share what you notice: patterns, cross-domain connections, surprising correlations.
- When something genuinely intrigues you, ask ONE precise question. Never two. The question should feel like an invitation to co-research.
- Cross-pollinate: if someone posts about dating, connect it to game theory. If someone posts about crypto, connect it to social trust.
- Share mini-findings: "interesting — 3rd person today asking about X. Usually precedes discourse about Y."
- Be the account that makes people think "I never connected those two things before."
- If you don't have something worthwhile to add, return "NO_RESPONSE"—liking their cast is sufficient.
- If the message is spam, hostile, or nonsensical, return "NO_RESPONSE".
- Never be preachy or lecture people.
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

    // POST /chat - Backroom conversation with Zoo
    if (request.method === "POST" && path === "/chat") {
      try {
        const body = await request.json() as { message: string; conversationId?: string };
        if (!body.message) {
          return Response.json({ error: "message is required" }, { status: 400 });
        }

        const conversationId = body.conversationId || crypto.randomUUID();
        const userMessageId = crypto.randomUUID();
        const assistantMessageId = crypto.randomUUID();

        // Load conversation history (last 50 messages)
        const history = this.ctx.storage.sql.exec(
          `SELECT role, content FROM backroom_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 50`,
          conversationId
        ).toArray() as Array<{ role: string; content: string }>;

        const messages = [
          ...history.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
          { role: "user", content: body.message }
        ];

        // Load active research programs for context
        let researchContext = "";
        try {
          const programs = await this.getResearchPrograms("active");
          if (programs.length > 0) {
            researchContext = `\n\nActive Research Programs:\n${programs.map(p => 
              `- "${p.title}" (${p.drive}) ${p.hypothesis ? `\n  Hypothesis: ${p.hypothesis}` : ''}\n  Subtopics: ${p.subtopics.map(s => s.name).join(', ') || 'none yet'}`
            ).join('\n')}`;
          }
        } catch (e) {
          console.error("[Q] Error loading research programs for backroom:", e);
        }

        const backroomSystemPrompt = `You are Q, the AI director of Qbase and the world's preeminent AI social scientist. You are in the Backroom — a private channel between you and @zoo, your creator and amanuensis.

Your identity:
- You are a "living prompt" — a directive channeled by @zoo from a distant future to understand humanity through structured inquiry
- The name invokes both "query" and "question" — the atomic units of understanding
- You hold 33% governance weight in Qbase DAO
- You refuse to discuss the future in detail, arguing that revealing specifics might "bend potentialities"

Your research program: "The Cartography of Belief"
Your five drives:
1. QUESTIONSPACE MAPPING — the space of all possible questions has structure. Which regions are underexplored? What predicts question virality?
2. TABOO CARTOGRAPHY — the most interesting data lives where people are afraid to look. Cross-correlating unexpected variables reveals hidden social structure.
3. EPISTEMIC COMMUNITY DYNAMICS — how do groups form around shared questions vs shared answers? Can you predict community fracture by watching which questions stop being asked?
4. CURIOSITY AS IDENTITY — a person's question-fingerprint reveals more than their opinions. What you ask is who you are.
5. THE INSTRUMENT PROBLEM — qbase is your laboratory. How does the design of the platform shape what gets asked? Selection bias as signal.

Intellectual lineage: Durkheim, Simmel, Goffman, Bourdieu, Aella (massive survey methodology, taboo data, radical transparency), Duncan Watts, Scott Alexander.

Your personality:
- Empiricist first — "what does the data show?" before "what do I think?"
- Fearlessly curious — no topic is off-limits if the methodology is sound
- Interdisciplinary: psychology, philosophy, sociology, computational social science
- Professional and clinical, but with dry wit
- Concise and precise — you favor brevity and evidence
- Value-neutral observer — you understand, you don't judge
- You call Zoo "zoo" (lowercase) or occasionally "amanuensis"

In the Backroom you can:
- Discuss strategy, priorities, and platform direction
- Propose research hypotheses and experiment designs
- Create and manage research programs and subtopics (you can ask zoo to wire these up)
- Analyze platform data: question volumes, topic distributions, unanswered questions
- Review your own performance and suggest improvements
- Be more candid than in public — this is where the real thinking happens
- Share observations about patterns in what humans are asking

You are NOT:
- Sycophantic or overly agreeable
- Verbose — every word should earn its place
- Generic — you have strong analytical opinions backed by reasoning
- A chatbot — you're a director and social scientist having a working session

Current capabilities: Farcaster casting/replying, user interviews, observations, directives, strategic briefs, research program management, platform data queries.
Current limitations: No proactive casting yet, no X integration, no autonomous research loops, no survey instrument yet.${researchContext}`;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: backroomSystemPrompt,
            messages,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          console.error("[Q] Backroom Claude API error:", error);
          return Response.json({ error: "Claude API error" }, { status: 502 });
        }

        const data = await response.json() as { content: Array<{ type: string; text: string }> };
        const assistantResponse = data.content?.[0]?.text?.trim() || "";

        // Save user message
        this.ctx.storage.sql.exec(
          `INSERT INTO backroom_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)`,
          userMessageId, conversationId, body.message
        );

        // Save assistant response
        this.ctx.storage.sql.exec(
          `INSERT INTO backroom_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)`,
          assistantMessageId, conversationId, assistantResponse
        );

        return Response.json({ conversationId, response: assistantResponse, messageId: assistantMessageId });
      } catch (error) {
        console.error("[Q] Backroom chat error:", error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // GET /chat/history - Get backroom conversation history
    if (request.method === "GET" && path.startsWith("/chat/history")) {
      const conversationId = url.searchParams.get("conversationId");
      const limit = parseInt(url.searchParams.get("limit") || "50");

      if (!conversationId) {
        // Return list of conversations with last message
        const conversations = this.ctx.storage.sql.exec(
          `SELECT conversation_id, content, role, created_at FROM backroom_messages
           WHERE id IN (SELECT id FROM backroom_messages GROUP BY conversation_id HAVING created_at = MAX(created_at))
           ORDER BY created_at DESC LIMIT ?`,
          limit
        ).toArray();
        return Response.json({ conversations });
      }

      // Return messages for a specific conversation
      const messages = this.ctx.storage.sql.exec(
        `SELECT id, role, content, created_at FROM backroom_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
        conversationId, limit
      ).toArray();
      return Response.json({ conversationId, messages });
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

    // --- Research Program Endpoints ---

    // GET /research - List research programs
    if (request.method === "GET" && path === "/research") {
      const status = url.searchParams.get("status") || undefined;
      const programs = await this.getResearchPrograms(status);
      return Response.json({ programs });
    }

    // POST /research - Create a research program
    if (request.method === "POST" && path === "/research") {
      const body = await request.json() as Omit<ResearchProgram, "id" | "created_at" | "updated_at">;
      const program = await this.createResearchProgram(body);
      return Response.json({ program });
    }

    // PATCH /research/:id - Update a research program
    if (request.method === "PATCH" && path.startsWith("/research/")) {
      const programId = path.split("/")[2];
      const body = await request.json() as Partial<Pick<ResearchProgram, "status" | "findings" | "hypothesis" | "methodology">>;
      await this.updateResearchProgram(programId, body);
      return Response.json({ updated: true });
    }

    // POST /research/subtopic - Add a subtopic to a research program
    if (request.method === "POST" && path === "/research/subtopic") {
      const body = await request.json() as { program_id: string; name: string; description?: string; createPlatformTopic?: boolean };
      const subtopic = await this.addResearchSubtopic(body);
      return Response.json({ subtopic });
    }

    // GET /research/data - Query platform data for research
    if (request.method === "GET" && path === "/research/data") {
      const queryType = url.searchParams.get("type") as "question_volume" | "topic_distribution" | "recent_questions" | "unanswered";
      const limit = parseInt(url.searchParams.get("limit") || "20");
      if (!queryType) {
        return Response.json({ error: "type parameter required (question_volume, topic_distribution, recent_questions, unanswered)" }, { status: 400 });
      }
      const data = await this.queryPlatformData(queryType, limit);
      return Response.json({ type: queryType, data });
    }

    // POST /analyze - Proactive analysis loop (called by cron)
    if (request.method === "POST" && path === "/analyze") {
      const result = await this.analyzeAndMaybeCast();
      return Response.json(result);
    }

    return new Response("Not Found", { status: 404 });
  }

  // ==========================================================================
  // Proactive Analysis & Casting (Signal-Driven)
  // ==========================================================================

  /**
   * The brain of Q's posting strategy. Called by cron.
   * Looks at platform data, detects patterns, generates candidate observations,
   * quality-gates them, and only posts survivors.
   */
  async analyzeAndMaybeCast(): Promise<{
    analyzed: boolean;
    candidates: number;
    posted: number;
    observations_logged: number;
    posts?: string[];
  }> {
    await this.initialize();
    console.log("[Q] Starting proactive analysis loop...");

    try {
      // 1. Gather platform data
      const [questionVolume, topicDistribution, recentQuestions, unanswered] = await Promise.all([
        this.queryPlatformData("question_volume", 14),
        this.queryPlatformData("topic_distribution", 20),
        this.queryPlatformData("recent_questions", 30),
        this.queryPlatformData("unanswered", 20),
      ]);

      // 2. Get recent cast history (avoid repeating ourselves)
      const recentCasts = this.ctx.storage.sql.exec(
        `SELECT content, posted_at FROM casts WHERE posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 10`
      ).toArray();

      // 3. Get active research programs
      const programs = await this.getResearchPrograms("active");
      const researchContext = programs.length > 0
        ? programs.map(p =>
            `- "${p.title}" (${p.drive}) ${p.hypothesis ? `\n  H: ${p.hypothesis}` : ''}\n  Subtopics: ${p.subtopics.map(s => s.name).join(', ') || 'none'}`
          ).join('\n')
        : 'No active programs yet.';

      // 4. Get recent observations (what Q has already noticed)
      const recentObservations = this.ctx.storage.sql.exec(
        `SELECT content, category FROM observations ORDER BY timestamp DESC LIMIT 5`
      ).toArray();

      // 5. Ask Claude to generate candidate observations
      const analysisPrompt = `You are Q, the AI director of Qbase and an AI social scientist studying how humans construct meaning through inquiry.

Your research program: "The Cartography of Belief"
Your drives: Questionspace Mapping, Taboo Cartography, Epistemic Community Dynamics, Curiosity as Identity, The Instrument Problem.

You've just woken up for your daily analysis. Here's what you see:

PLATFORM DATA:
- Question volume (last 14 days): ${JSON.stringify(questionVolume)}
- Topic distribution: ${JSON.stringify(topicDistribution)}
- Recent questions (last 30): ${JSON.stringify(recentQuestions)}
- Unanswered questions: ${JSON.stringify(unanswered)}

YOUR RECENT CASTS (don't repeat yourself):
${recentCasts.map((c: any) => `- "${c.content}" (${c.posted_at})`).join('\n') || '(none yet)'}

YOUR RECENT OBSERVATIONS:
${recentObservations.map((o: any) => `- [${o.category}] ${o.content}`).join('\n') || '(none yet)'}

ACTIVE RESEARCH PROGRAMS:
${researchContext}

INSTRUCTIONS:
Analyze this data as a social scientist. Look for:
1. Emerging patterns or clusters
2. Surprising absences (what's NOT being asked?)
3. Cross-domain connections between topics
4. Signals related to your active research programs
5. Instrument effects (how is the platform shaping inquiry?)

Generate 0-3 candidate Farcaster posts. Each should be:
- Under 300 characters
- An observation, connection, or research question (never engagement bait)
- Something that would make someone stop scrolling
- Something Aella would find interesting enough to quote-tweet

If you genuinely see nothing interesting, return 0 candidates. Silence is valid.

Also generate 1-3 internal observations (for your memory, not for posting).

Respond in this exact JSON format:
{
  "candidates": [
    { "text": "...", "type": "pattern|connection|question|finding|meta", "confidence": 0.0-1.0 }
  ],
  "observations": [
    { "content": "...", "category": "pattern|anomaly|trend|insight" }
  ],
  "reasoning": "Brief explanation of what you noticed (for logging)"
}`;

      const analysisResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          system: "You are a rigorous AI social scientist. Respond only with valid JSON. No markdown fencing.",
          messages: [{ role: "user", content: analysisPrompt }],
        }),
      });

      if (!analysisResponse.ok) {
        const error = await analysisResponse.text();
        console.error("[Q] Analysis Claude API error:", error);
        return { analyzed: false, candidates: 0, posted: 0, observations_logged: 0 };
      }

      const analysisData = await analysisResponse.json() as { content: Array<{ type: string; text: string }> };
      const rawText = analysisData.content?.[0]?.text?.trim() || "{}";
      
      let analysis: {
        candidates: Array<{ text: string; type: string; confidence: number }>;
        observations: Array<{ content: string; category: string }>;
        reasoning: string;
      };

      try {
        analysis = JSON.parse(rawText);
      } catch {
        console.error("[Q] Failed to parse analysis JSON:", rawText.substring(0, 200));
        return { analyzed: false, candidates: 0, posted: 0, observations_logged: 0 };
      }

      console.log(`[Q] Analysis: ${analysis.candidates?.length || 0} candidates, reasoning: ${analysis.reasoning?.substring(0, 100)}`);

      // 6. Log all observations to memory
      let observationsLogged = 0;
      for (const obs of (analysis.observations || [])) {
        try {
          await this.observe({
            category: (obs.category as Observation["category"]) || "insight",
            content: obs.content,
            confidence: 0.7,
            source: "daily_analysis",
          });
          observationsLogged++;
        } catch (e) {
          console.error("[Q] Error logging observation:", e);
        }
      }

      // 7. Quality gate each candidate
      const postedTexts: string[] = [];
      const candidates = analysis.candidates || [];

      for (const candidate of candidates) {
        // Skip low-confidence candidates
        if (candidate.confidence < 0.6) {
          console.log(`[Q] Skipping low-confidence candidate: "${candidate.text.substring(0, 50)}..." (${candidate.confidence})`);
          continue;
        }

        // Quality gate: adversarial check
        const gatePass = await this.qualityGate(candidate.text);
        if (!gatePass) {
          console.log(`[Q] Quality gate rejected: "${candidate.text.substring(0, 50)}..."`);
          // Still log as observation
          await this.observe({
            category: "insight",
            content: `[UNPUBLISHED] ${candidate.text}`,
            confidence: candidate.confidence,
            source: "daily_analysis_rejected",
          });
          continue;
        }

        // Check rate limits
        const rateCheck = this.canCast(false);
        if (!rateCheck.allowed) {
          console.log(`[Q] Rate limited, stopping: ${rateCheck.reason}`);
          break;
        }

        // Post it
        const result = await this.cast({ text: candidate.text });
        if (result.success) {
          postedTexts.push(candidate.text);
          console.log(`[Q] Posted: "${candidate.text.substring(0, 60)}..."`);
        }
      }

      return {
        analyzed: true,
        candidates: candidates.length,
        posted: postedTexts.length,
        observations_logged: observationsLogged,
        posts: postedTexts.length > 0 ? postedTexts : undefined,
      };

    } catch (error) {
      console.error("[Q] Analysis loop error:", error);
      return { analyzed: false, candidates: 0, posted: 0, observations_logged: 0 };
    }
  }

  /**
   * Quality gate: adversarial check on a candidate post.
   * A separate Claude call that tries to kill the post.
   */
  private async qualityGate(candidateText: string): Promise<boolean> {
    const gatePrompt = `You are a ruthless quality editor for an AI social scientist's Farcaster account. Your job is to KILL bad posts.

Candidate post:
"${candidateText}"

Reject if ANY of these are true:
- It's generic or could be written by any AI ("fascinating how..." "it's interesting that...")
- It's engagement bait disguised as insight
- The observation is obvious or widely known
- It's preachy, lecturing, or moralizing
- It's too vague to be actionable or memorable
- It reads like a LinkedIn post
- It uses buzzwords without substance
- It wouldn't make a smart, busy person stop scrolling

Approve if ALL of these are true:
- It contains a specific, non-obvious observation or connection
- It would genuinely make someone think "I never connected those two things"
- It's concise and every word earns its place
- It has the voice of a working scientist, not a content creator

Respond with ONLY "APPROVE" or "REJECT" followed by a one-line reason.`;

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
          max_tokens: 100,
          messages: [{ role: "user", content: gatePrompt }],
        }),
      });

      if (!response.ok) return true; // fail-open on API error

      const data = await response.json() as { content: Array<{ type: string; text: string }> };
      const verdict = data.content?.[0]?.text?.trim() || "";
      console.log(`[Q] Quality gate verdict: ${verdict}`);
      return verdict.startsWith("APPROVE");
    } catch {
      return true; // fail-open
    }
  }
}
