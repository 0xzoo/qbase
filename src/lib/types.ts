// React import for types only
import React from 'react'

export type AgentMode = 'broker' | 'cast' | 'interview'

export interface QbaseContextValue {
  /** The authenticated user, undefined if not authenticated */
  user: UserProfile | undefined
  /** Whether a user is authenticated - derived from user state */
  isConnected: boolean
  /** Authentication-related error messages */
  qs: Query[]
  setQs: (qs: Query[]) => void
  queueIndex: number
  setQueueIndex: (index: number) => void
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  loading: boolean
  setLoading: (loading: boolean) => void
  connectUser: () => Promise<void>
  disconnectUser: () => void
  connectWallet: () => void
  error: string | null
}

export type ComposerStatus =
  'start' // starting q mode
  | 'search' // activates search query
  | 'similars' // view similar qs
  | 'coin' // default with no parent q
  | 'q' // view q detail
  | 'use' // pre 'fork' with no changes, defaults to share parent q
  | 'fork' // with parent q but different type/a_options
  | 'answer' // answer mode
  | 'casting'


//// postgres ////
export type Social = "x" | "farcaster" | "github"
export type UserAction = 'coin' | 'sendDirect' | 'answer' | 'tip'

export type UserPreferences = {
  audience: Audiences,
}

/**
 * User settings stored in KV (KV_USER_PROFILES namespace)
 * Key pattern: settings:{fid}
 */
export interface UserSettings {
  /** Default visibility/audience preference for answers */
  defaultAudience: Audiences;
  /** Theme preference */
  theme?: 'light' | 'dark' | 'auto';
  /** Notification preferences */
  notifications?: {
    directQuestions?: boolean;
    answers?: boolean;
    reactions?: boolean;
  };
  /** Whether to include question embed in answer casts (default: false) */
  includeEmbedInAnswerCasts?: boolean;
  /** Whether to include miniapp embed in question casts (default: true) */
  includeEmbedInQuestionCasts?: boolean;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * User pricing configuration stored in KV (KV_USER_PROFILES namespace)
 * Key pattern: user_pricing:{fid}
 * Used for custom pricing in direct queries based on expertise/reputation
 */
export interface UserPricingConfig {
  /** Whether custom pricing is enabled for this user */
  enabled: boolean;
  /** Base price for social direct queries (in QP) */
  social_qp_price?: number; // Default: 10 QP
  /** Base price for expert direct queries (in $QQ tokens, as integer with decimals) */
  expert_qq_price?: number; // Price in smallest unit (e.g., wei for tokens)
  /** Pricing multiplier based on expertise/reputation tier */
  expertise_multiplier?: number; // e.g., 1.0 = base, 1.5 = 50% premium, 2.0 = 2x
  /** Minimum price floor (in QP or $QQ depending on query type) */
  min_price?: number;
  /** Maximum price ceiling (in QP or $QQ depending on query type) */
  max_price?: number;
  /** Category-specific pricing overrides */
  category_pricing?: {
    [category: string]: {
      qp_price?: number;
      qq_price?: number;
      multiplier?: number;
    };
  };
  /** Last updated timestamp */
  updatedAt: number;
}

export type UserContext = {
  fid: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  location?: AccountLocation;
}

export type AccountLocation = {
  placeId: string;
  /**
   * Human-readable string describing the location
   */
  description: string;
};

export type User = {
  id: number,
  fid?: number,
  fname?: string,
  created_at: number,
  q_cost?: number,
  primary_address?: string,
  addresses?: { address: string, chain: string }[]
  socials?: { social: Social, id: string, name?: string }[]
}

export type UserPoints = {
  balance: number,
  allowance: number,
}

export type UserPointsTotal = {
  periodBalance: number,
  remainingDailyAllowance: number,
  qqBalance: number,
}

// Points information is now fetched from KV
export type UserWPoints = User & {
  points_balance: number,
  points_allowance: number,
}

export type FCUser = {
  fid: number
  username: string
  displayName: string
  avatarUrl: string
  custodyWalletAddress: string
  customName?: string
}

export type UserProfile = FCUser & {
  id: number  // Internal Qbase ID
  connectedWalletAddress: string
  ogImageUrl?: string
  q_cost?: number
}

export type QueryUserData = {
  fid: number,
  profileName: string,
  address?: string
}

export type Points = {
  balance: number | null,      // Total points balance from KV
  allowance: number | null,    // Remaining daily allowance from KV
  cost: number | null          // Cost of current operation
}

export type AllowlistType = 'manual' | 'my_followers' | 'my_following' | 'mutual_followers' | 'besties'

export interface Allowlist {
  id: string;
  user_id: number;
  name: string;
  description?: string;
  list_type: AllowlistType;
  source_params?: string; // JSON: { fid: number, limit?: number }
  members?: string; // JSON array of internal user IDs (NULL for dynamic types)
  created_at: number;
  updated_at: number;
}

export interface AllowlistWithMembers extends Allowlist {
  memberIds?: number[]; // Parsed members array
  memberCount?: number;  // For display purposes
}

export const QueryType = {
  MC: "mc",
  CHECKBOX: "checkbox",
  TEXT: "text",
  SCALE: "scale",
  SCALE_RANGE: "scale_range",
  DATE: "date"
} as const

export type QueryType = typeof QueryType[keyof typeof QueryType]

/**
 * Answer type IDs for the answer_types lookup table.
 * These map to the `id` column in the `answer_types` table.
 * Using integers allows adding new types without schema changes.
 */
export const AnswerTypeId = {
  TEXT: 1,
  MC: 2,
  SCALE: 3,
  CHECKBOX: 4,
  DATE: 5,
} as const

export type AnswerTypeId = typeof AnswerTypeId[keyof typeof AnswerTypeId]

/**
 * Maps QueryType strings to AnswerTypeId integers.
 */
export const queryTypeToAnswerTypeId: Record<QueryType, number> = {
  'text': AnswerTypeId.TEXT,
  'mc': AnswerTypeId.MC,
  'scale': AnswerTypeId.SCALE,
  'scale_range': AnswerTypeId.SCALE,
  'checkbox': AnswerTypeId.CHECKBOX,
  'date': AnswerTypeId.DATE,
}

// ============================================================================
// Answer Data Types
// Structured data stored alongside the human-readable `value` field
// ============================================================================

/**
 * Structured data for answers - extensible for future answer types.
 * 
 * The `value` field always contains human-readable display text.
 * The `answer_data` field contains type-specific structured data:
 * 
 * Current types:
 * - MC (2): { index: number }
 * - Checkbox (4): { indices: number[] }
 * 
 * Future types could include:
 * - Ranking: { indices: number[] } (ordered by preference)
 * - Range: { min: number, max: number }
 * - Location: { lat: number, lng: number }
 * - Date: { iso: string }
 * - Matrix: { responses: Array<{row: number, value: number}> }
 */
export interface AnswerData {
  /** MC answers: index of selected option. Scale answers: numeric value selected. */
  index?: number;
  /** Checkbox/Ranking answers: array of selected option indices */
  indices?: number[];
  /** Future: range answers */
  min?: number;
  max?: number;
  /** Date answers: ISO 8601 date or datetime string (YYYY-MM-DD or YYYY-MM-DDTHH:mm) */
  iso?: string;
  /** Allow additional fields for future extensibility */
  [key: string]: unknown;
}

/**
 * Configuration for date-type questions.
 * `include_time = true` switches the picker from `<input type="date">` to
 * `<input type="datetime-local">` and asks for a YYYY-MM-DDTHH:mm ISO string.
 */
export interface DateConfig {
  include_time?: boolean;
}

/** Value structure for checkbox (multi-select) answers - used in component state */
export interface CheckboxAnswerValue {
  text: string;      // Comma-joined selected options (display text)
  indices: number[]; // Array of selected option indices
}

/**
 * Answer type definition from the answer_types table.
 */
export interface AnswerType {
  id: number;
  name: string;
  description?: string;
  json_schema: string;
  created_at: string;
}

export type SimilarityCheckResponse = {
  status: 'duplicate' | 'similar' | 'unique'
  results: SearchResult[]
  id?: string
}
// export type AnswerType = "public" | "anon" | "private" | "gated"
// export enum AnswerTypes {
//   public = 'public',
//   anon = 'anon',
//   private = 'private',
//   gated = 'gated'
// }

export interface ScaleConfig {
  min: number;
  max: number;
  step?: number;
  showNumericValue?: boolean;
  minLabel?: string;
  maxLabel?: string;
  customLabels?: {
    value: number;
    label: string;
  }[];
}

/**
 * Eligibility gate config the client submits when creating a poll.
 * The server resolves this to a full `EligibilityGate` (snapshot_fids,
 * holder_address_count, snapshotted_at, plus token_snapshot extras) at
 * creation time — clients never resolve this themselves.
 *
 * v0 gate types:
 *   - `nft_snapshot`: holders of an NFT collection at poll-creation
 *   - `token_snapshot`: holders with at least `min_balance` of an ERC-20
 *     at poll-creation. `min_balance` is human-readable (e.g. "4420000");
 *     the server fetches `decimals()` and stores both forms.
 */
export type EligibilityGateSubmission =
  | { type: 'nft_snapshot'; contract: string; chain: 'base' }
  | { type: 'token_snapshot'; contract: string; chain: 'base'; min_balance: string };

/**
 * Resolution metadata produced by the snapshot pipeline. Common to every
 * gate variant — shared via intersection rather than `extends` so the
 * discriminated `type` field stays narrowable.
 */
interface EligibilityGateResolution {
  /** Resolved Farcaster FIDs of holders meeting the gate. Deduped. */
  snapshot_fids: number[];
  /** Total holder addresses found onchain (incl. unverified). */
  holder_address_count: number;
  /** ISO timestamp when the snapshot was taken. */
  snapshotted_at: string;
}

/**
 * Eligibility gate stored on a poll (queries.eligibility_gate JSON column).
 * Snapshots are immutable; the per-vote check is a list lookup against
 * `snapshot_fids`. Coverage gap: an address is only in `snapshot_fids` if
 * it's verified on Farcaster — compare to `holder_address_count` to surface.
 */
export type EligibilityGate =
  | ({ type: 'nft_snapshot'; contract: string; chain: 'base' } & EligibilityGateResolution)
  | ({
      type: 'token_snapshot';
      contract: string;
      chain: 'base';
      /** Human-readable threshold the creator typed, e.g. "4420000" */
      min_balance: string;
      /** Raw uint256 (string for safe big-int transport), already × 10^decimals */
      min_balance_wei: string;
      /** Decimals fetched from the contract at snapshot time (typically 18) */
      decimals: number;
      /** Token symbol fetched from the contract for display ("$QQ"); optional — symbol() can revert */
      symbol?: string;
    } & EligibilityGateResolution);

/** Wave kind: 'measure' (unstaked, anon allowed) or 'decide' (staked, delegable — Track D). */
export type PollKind = 'measure' | 'decide';

/**
 * A wave (poll) over a question, as served by the API. The resolved FID
 * list is never shipped; `is_closed` is computed server-side at read time.
 */
export interface Poll {
  id: string;
  question_id: string;
  /** ISO; voting through this wave locks past this point */
  closes_at: string;
  is_closed: boolean;
  kind: PollKind;
  eligibility_gate?: Omit<EligibilityGate, 'snapshot_fids'>;
  options_config?: OptionsConfig;
  author_fid?: number;
  cast_hash?: string;
  channel_id?: string;
  created_at: string;
}

/** Body of POST /api/polls — open a wave on an existing question. */
export interface PollSubmission {
  question_id: string;
  closes_at: string;
  eligibility_gate?: EligibilityGateSubmission;
  options_config?: OptionsConfig;
  channel_id?: string;
  kind?: PollKind;
  /** Force a fresh holder snapshot instead of reusing a prior identical one. */
  resnapshot?: boolean;
}

/**
 * Farcaster Channel - used for posting questions to channels
 */
export interface FarcasterChannel {
  id: string;
  url: string;
  name: string;
  description?: string;
  image_url?: string;
  follower_count?: number;
  lead?: {
    fid: number;
    username: string;
    display_name: string;
    pfp_url?: string;
  };
}

export type QueryEntry = {
  id: string,
  stem: string,
  type: QueryType,
  coiner_id: number | { '%allot': number },
  pub_answers: number,
  priv_answers: number,
  coiner_fname?: string,
  coiner_fid?: number,
  a_options?: string[],
  scale_config?: ScaleConfig,
  date_config?: DateConfig,
  closes_at?: string,                     // ISO; null/undefined = evergreen
  eligibility_gate?: EligibilityGate,     // resolved gate (server-populated)
  casthash?: string,
  assets?: string[],
  owner_id: number | { '%allot': number },
  token_id?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  cost: number,
  template?: boolean,
  channel_id?: string,      // Optional: Farcaster channel ID (e.g., "farcaster", "degen")
}

/**
 * Open-options poll config. Stored as queries.options_config (JSON). Absent/NULL
 * = classic closed MC (zero behavior change). See docs/plans/open-options-poll.md.
 */
export type OptionsConfig = {
  /** Always true when present — respondents may write in new options. */
  open: boolean,
  /** Max options (seed + write-in). Default 24. Write-in input hides at cap. */
  cap: number,
  /** Write-ins allowed per user per poll. Default 1. */
  writeins_per_user: number,
}

/** A single open-poll option. The creator's FID is never shipped to clients. */
export type PollOption = {
  id: string,
  label: string,
  source: 'seed' | 'writein',
  created_at: string,
  hidden: boolean,
}

// QuerySubmission is what comes from the frontend
// coiner_id, coiner_fid, and coiner_fname are optional because
// they are injected by the server from authenticated user data
export type QuerySubmission = {
  stem: string,
  type: QueryType,
  coiner_id?: number,       // Optional: Set by server from auth
  coiner_fname?: string,    // Optional: Set by server from auth
  coiner_fid?: number,      // Optional: Set by server from auth
  a_options?: string[],
  scale_config?: ScaleConfig,
  date_config?: DateConfig,
  closes_at?: string,                                 // ISO; voting locks past this point
  eligibility_gate?: EligibilityGateSubmission,       // server resolves to full EligibilityGate at create time
  options_config?: OptionsConfig,                     // open-options poll (mc only); seeds come from a_options
  casthash?: string,
  assets?: string[],
  token_id?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  cost?: number,
  isAnon?: boolean,
  template?: boolean,
  channel_id?: string,      // Optional: Farcaster channel ID to post the question to
  includeEmbed?: boolean,   // Optional: Include miniapp embed in cast (default: true from settings)
  cast_mode?: 'server' | 'client' | 'none',  // Optional: who casts (default 'server' — existing behavior)
  forked_from?: string,     // Optional: question_id this is a fork of (re-ask with different shape)
  resnapshot?: boolean,     // Optional: force a fresh holder snapshot instead of reusing a prior identical one
}

export type EncryptedQuerySubmission = Omit<QuerySubmission, 'coiner_id'> & {
  coiner_id: number | { '%allot': number },
  token_id?: string,
  a_options?: string[],
  scale_config?: ScaleConfig,
  date_config?: DateConfig,
  closes_at?: string,
  eligibility_gate?: EligibilityGateSubmission,
  casthash?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  assets?: string[],
  template?: boolean,
  channel_id?: string,
}

// Query is a fully formed query with all required fields
/**
 * Represents a fully formed query with all required fields.
 * This is the core data structure for questions in the system.
 */
export type Query = {
  /** Unique identifier for the query (UUID) */
  id: string,
  /** The text content of the question */
  stem: string,
  /** Timestamp of creation (unix epoch) */
  created_at: number,
  /** Type of the query (mc, text, scale, etc.) */
  type: QueryType,
  /** Number of public answers received */
  pub_answers: number,
  /** Number of private answers received */
  priv_answers: number,
  /** Total number of comments/answers (aggregate of pub + priv) */
  comments?: number,
  /** ID of the user who coined (created) the query */
  coiner_id?: number,
  /** ID of the current owner of the query NFT */
  owner_id: number,
  /** Cost to answer the query (in points) */
  cost: number,
  /** Farcaster username of the coiner */
  coiner_fname?: string,
  /** Farcaster ID of the coiner */
  coiner_fid?: number,
  /** Profile picture URL of the coiner (fetched from Farcaster) */
  coiner_avatar_url?: string,
  /** NFT Token ID if minted */
  token_id?: string,
  /** Array of answer options for MC questions (JSON string in DB) */
  a_options?: string[],
  /** Open-options poll config (mc only); absent = classic closed MC */
  options_config?: OptionsConfig,
  /** Live option set for an open poll (visible only, declared order) */
  poll_options?: PollOption[],
  /** The wave this payload answers through (?poll= or the open wave), if any */
  current_poll?: Poll,
  /** Configuration for scale-type questions */
  scale_config?: ScaleConfig,
  /** Configuration for date-type questions */
  date_config?: DateConfig,
  /** ISO timestamp when voting closes; null/undefined = evergreen (qbase default) */
  closes_at?: string,
  /** Resolved eligibility gate (server-populated at poll-creation time) */
  eligibility_gate?: EligibilityGate,
  /** Farcaster cast hash if published to Farcaster */
  casthash?: string,
  /** Tags associated with the query */
  tags?: string[],
  /** Farcaster parent cast hash for thread context (not a fork edge — see forked_from) */
  parent?: string,
  /** question_id this question was forked from (re-ask with a different answer shape) */
  forked_from?: string,
  /** Stem of the question this was forked from (populated by GET /api/queries/:id for the backlink) */
  forked_from_stem?: string,
  /** Author username of the question this was forked from (populated by GET /api/queries/:id) */
  forked_from_coiner_fname?: string,
  /** Author FID of the question this was forked from (populated by GET /api/queries/:id) */
  forked_from_coiner_fid?: number,
  /** Requirements/Gating criteria */
  reqs?: string[],
  /** Attached assets (images, etc.) */
  assets?: string[]
  /** Whether this query is a template */
  template?: boolean
  /** Multi-dimensional taxonomy classification */
  taxonomy?: QuestionTaxonomy
  /** Farcaster engagement data */
  farcaster_likes?: number
  farcaster_recasts?: number
  farcaster_replies?: number
  /** Whether the current authenticated user has liked this query */
  user_has_liked?: boolean
  /** Whether the current authenticated user has recasted this query */
  user_has_recasted?: boolean
}

/**
 * Multi-dimensional taxonomy for question classification.
 * See docs/question-taxonomy.md for full specification.
 */
export type QuestionTaxonomy = {
  /** Primary type - determines storage (identity_answers vs recurring_answers vs prospective_answers vs knowledge_answers) */
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive' | 'invalid';
  /** Knowledge subtype - only present when primary_type is 'knowledge' */
  knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
  /** Construction type - how the question is structured */
  construction_type: 'complete' | 'template' | 'follow_up';
  /** Content tags - what the question captures (can have multiple, mainly for non-knowledge types) */
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'emotional' | 'demographic' | 'social' | 'evaluative' | 'personal_history'>;
  /** AI-generated topics (2-3 relevant categories) - domain/subject areas (1-3, mainly for knowledge questions) - plus user added categories */
  topics: string[];
  /** Sensitivity level - privacy implications */
  sensitivity?: 'low' | 'medium' | 'high';
  /** Temporal markers found in the question (if recurring) */
  temporal_markers?: string[];
  /** Safety flag - true if question contains NSFW, hate speech, or dangerous content */
  safety_flag?: boolean;
  /** Shorthand for construction_type === 'template' */
  is_template: boolean;
  /** Explanation of classification */
  reasoning: string;
}

export type QueryWUsers = Query & {
  owner_fname?: string,
}

/**
 * Represents an answer to a query.
 */
export type Answer = {
  /** Unique identifier for the answer (UUID) */
  id: string,
  /** Timestamp of creation (unix epoch) */
  created_at: number,
  /** ID of the query being answered */
  q_id: string,
  /** ID of the user who answered */
  user_id: number,
  /** The answer content as plain display text */
  value: string,
  /** ID of the answer type - integer FK to answer_types table */
  answer_type_id: number,
  /** ID of the suggested answer type (from question) - integer FK to answer_types table */
  suggested_answer_type_id: number,
  /** 
   * Type-specific structured data (indices, ranges, etc.)
   * See AnswerData interface for structure.
   */
  answer_data?: AnswerData,

  /** Privacy setting for the answer (Public, Private, etc.) */
  audience: Audiences,
  /** Whether the answer has been edited */
  edited: boolean,
  /** URI of attached asset */
  asset?: string,
  /** Farcaster cast hash if the answer was casted */
  casthash?: string,
  /** Farcaster cast hash of the parent cast (query) */
  parent_casthash?: string,
  /** List of FIDs allowed to view the answer (for Allowlist audience) */
  allowlist?: string[],
  /** Flag indicating this is user's own anonymous answer (only visible to them) */
  is_own_anon?: boolean,
  /** Primary type from question taxonomy (identity, recurring, etc.) */
  primary_type?: string,
  /** Number of likes on this answer */
  like_count?: number,
  /** Whether the current user has liked this answer */
  user_has_liked?: boolean,
  /** Cached Farcaster like count for the answer's cast (cast answers only) */
  farcaster_likes?: number,
  /** Cached Farcaster recast count for the answer's cast (cast answers only) */
  farcaster_recasts?: number,

  /** Oracle (model-generated) answer fields */
  answer_source?: 'human' | 'oracle_qlaude' | 'oracle_chatqpt' | 'oracle_qemini';
  /** The specific model version that generated this answer (e.g. 'claude-opus-4-20250514') */
  oracle_model?: string;
  /** Token count for the oracle response */
  oracle_tokens?: number;
  /** $QQ cost as a decimal string */
  oracle_cost_qq?: string;
  /** Whether the model refused to answer */
  oracle_refused?: boolean;
}

export type AnswerEntry = {
  id: string,
  q_id: string,
  user_id: number | { '%allot': number },
  value: string | { '%allot': string },
  answer_type_id: number,
  suggested_answer_type_id: number,
  answer_data?: AnswerData,

  audience: Audiences,
  edited: boolean,
  asset?: string,
  casthash?: string,
  parent_casthash?: string,
  allowlist?: string[], // JSON array stored as string in DB,
}

export type AnswerSubmission = Omit<Answer, 'id' | 'created_at' | 'edited'> & {
  q_owner: number,
  previous_id?: string
}

export type AnswerWFname = Answer & {
  fname: string,
}

export type AnswerWQData = Answer & {
  stem: string
  a_options?: string // JSON array
}

// export type QueryAnswersData = {
//   id: string
//   value: string
//   q_id: string
//   user_id: string
//   fname: string
// }

export type DirectQuery = {
  id: string,
  sender_id: number,
  recipient_id: number,
  q_id: string,
  sent_at: number,
  answered: boolean,
  removed: boolean,
  cost: number,
  tx?: string,
  casthash?: string
}

export type DirectQueryEntry = {
  id: string,
  sender_id: number | { '%allot': number },
  recipient_id: number,
  q_id: string,
  answered: false,
  removed: false,
  cost: number,
  tx?: string,
  casthash?: string
}

export type DirectQuerySubmission = Omit<DirectQueryEntry, 'id'> & {
  sender_id: number,
  points_balance: number,
  points_allowance: number,
  isAnon?: boolean
}

export type DirectQueryWithQuery = DirectQuery & Query & {
  sender_fname: string,
  sender_fid: number
}

export type DirectQCardData = DirectQueryWithQuery & {
  sender_pfp_url?: string
}

export type DirectQueryResponse = {
  id: string,
  direct_q_id: string,
  recipient_id: number,
  status: 'accepted' | 'rejected' | 'counter_offered',
  counter_amount?: number,
  reason?: string,
  created_at: number
}

export type Cast = {
  url: string
}

//// Farcaster Integration ////

/**
 * Represents a Farcaster cast reference for a qbase entity (query or answer).
 * Tracks the cast status and enables lazy health checking.
 */
export type FarcasterCast = {
  /** Unique identifier */
  id: string
  /** Type of entity this cast represents */
  entity_type: 'query' | 'answer'
  /** ID of the qbase entity (query_id or answer_id) */
  entity_id: string
  /** Farcaster cast hash */
  cast_hash: string
  /** Full URL to the cast on Farcaster client */
  cast_url: string
  /** Farcaster ID of the user who posted the cast */
  caster_fid: number
  /** Whether the cast is currently active on Farcaster */
  is_active: boolean
  /** Last time we checked if the cast exists (unix timestamp) */
  last_checked_at?: number
  /** When the cast was created (unix timestamp) */
  created_at: number
}

/**
 * Represents a reaction (like/recast) to a Farcaster cast.
 * Preserved even if the original cast disappears.
 */
export type FarcasterReaction = {
  /** Unique identifier */
  id: string
  /** Cast hash this reaction is for */
  cast_hash: string
  /** FID of the user who reacted */
  reactor_fid: number
  /** Type of reaction */
  reaction_type: 'like' | 'recast'
  /** When this reaction was synced to qbase */
  synced_at: number
  /** Where the reaction originated from */
  source: 'farcaster' | 'qbase'
  /** Whether the reaction was removed */
  is_deleted: boolean
  /** When the reaction was deleted */
  deleted_at?: number
  /** When the reaction was created on Farcaster */
  created_at: number
}

/**
 * Represents a reply cast to one of our casts.
 * Stored to preserve conversation context.
 */
export type FarcasterReply = {
  /** Unique identifier */
  id: string
  /** Cast hash of the parent cast */
  parent_cast_hash: string
  /** Cast hash of the reply */
  reply_cast_hash: string
  /** FID of the reply author */
  author_fid: number
  /** Reply text content */
  text: string
  /** Whether the reply still exists on Farcaster */
  is_active: boolean
  /** Last time we checked if reply exists */
  last_checked_at?: number
  /** When the reply was created */
  created_at: number
  /** When we synced this reply to qbase */
  synced_at: number
}

/**
 * Aggregated Farcaster engagement data for an entity.
 * Used for efficient display of engagement metrics.
 */
export type FarcasterEngagementData = {
  /** Cast information if entity has been casted */
  cast?: FarcasterCast
  /** Total number of likes (excluding deleted) */
  total_likes: number
  /** Total number of recasts (excluding deleted) */
  total_recasts: number
  /** Total number of replies */
  total_replies: number
  /** Recent reactions (for showing avatars, etc.) */
  recent_reactions?: FarcasterReaction[]
  /** Recent replies (for previewing conversation) */
  recent_replies?: FarcasterReply[]
}

/**
 * Webhook sync event for tracking and debugging.
 */
export type FarcasterSyncEvent = {
  /** Unique identifier */
  id: string
  /** Type of webhook event */
  event_type?: string
  /** Cast hash related to the event */
  cast_hash?: string
  /** Webhook delivery ID (for idempotency) */
  webhook_id?: string
  /** Full webhook payload */
  payload?: object
  /** When the event was processed */
  processed_at: number
  /** Whether processing succeeded */
  success: boolean
  /** Error message if processing failed */
  error_message?: string
}

//// vectorize ////

export interface EmbeddingResponse {
  shape: number[];
  data: number[][];
}

export interface VectorMetadata {
  dimensions: number  // 768
  model: 'cloudflare:cf/baai/bge-base-en-v1.5'
  created_at: string
  _id: string
  topics: number[]
}

export type VectorizeIndex = 'a' | 'q'

export type VectorMetadataWithIndex = VectorMetadata & {
  index: VectorizeIndex
}

export interface SearchResult {
  id: string
  score: number
  metadata: VectorMetadata
}

export interface VectorizeMatch {
  id: string
  score: number
  values: number[]
  metadata?: VectorMetadata
}

export interface VectorizeMatches {
  count: number
  matches: VectorizeMatch[]
}

export interface QueryOptions {
  topK?: number
  returnValues?: boolean
  returnMetadata?: 'none' | 'all'
}

export type CoinQResponse = {
  id: string
}


///////////////////////////////////// Validation errors /////////////////////////////////////
export type ErrorLoc = [
  string: string,
  number: number
]
export type ErrorDetail = {
  type: string,
  loc: ErrorLoc,
  msg: string,
  input: string,
  url: string
}
export type ValidationError = {
  detail: ErrorDetail[]
}

//// airstack ////
type Wallet = {
  address: string,
  blockchain: string
}

type ProfileData = {
  profileName: string,
  image: string,
  wallets: Wallet[]
}

export type ProfileDataResponse = {
  profileData: ProfileData,
  error: Error | null
}

export type CastData = {
  text: string,
  castedAtTimestamp: string
}

export type CastDataResponse = {
  castData: CastData,
  errorResponse: Error | null
}

//////////////////////////////////////// client //////////////////////////////////////////
export type QueryCategoryProps = {
  id: number
  name: string
  tag: string
  // loading: boolean
  // data: Q[]
  query: string
  queryKey: string
}

export interface CustomTabPanelProps {
  children?: React.ReactNode
  key: number
  id: number
  // React ref type
  ref?: React.ForwardedRef<HTMLDivElement>
  category: QueryCategoryProps
}

export const Audiences = {
  PRIVATE: 'Private',
  ALLOWLIST: 'Allowlist',
  PUBLIC: 'Public',
  ANON: 'Anon'
} as const

export type Audiences = typeof Audiences[keyof typeof Audiences]

export const AudienceEncryption = {
  private: {
    user_id: true,
    value: true,
  },
  allowlist: {
    user_id: false,
    value: true,
  },
  public: {
    user_id: false,
    value: false,
  },
  anon: {
    user_id: true,
    value: false,
  }
}

export type QAProps = {
  qIndex: number | undefined
  handleMcRadio: (i: string) => void
  audience: Audiences
  handleAudience: (a: Audiences) => void
  // handleImportance: (i: number) => void
  value: string
  handleValue: (s: string) => void
  initialRef: React.RefObject<null>
  currentQ: QueryWUsers,
  userAnswers: Answer[] | undefined,
  qAView?: QAViews,
  handleStatus?: () => void
}

export const QAViews = {
  RESPOND: 'Respond',
  PUBLIC: 'PublicAs',
  FORKS: 'Forks',
  FUPS: 'FollowUps'
} as const

export type QAViews = typeof QAViews[keyof typeof QAViews]

export type QAViewProps = {
  qIndex: number | undefined
  handleMcRadio: (i: string) => void
  value: string
  handleValue: (s: string) => void
  currentQ: Query
  userAnswers: Answer[] | undefined
  initialRef: React.MutableRefObject<null>
  audience: Audiences
  handleAudience: (a: Audiences) => void
  // handleImportance: (i: number) => void
  qAView: QAViews
  handleQAViewChange: (view: QAViews) => void
}



//// other ////
// export type Rarity = "SS" | "S" | "A" | "B" | "C" | "D" | "F"
export type Rarity = "Rare" | "Common" | "Normie"

export type ConversationDimension =
  | 'factual'      // observable facts, data, events
  | 'experiential' // personal experiences, memories, stories
  | 'emotional'    // feelings, reactions, relationships
  | 'analytical'   // reasoning, patterns, systems
  | 'values'       // ethics, principles, what matters
  | 'imaginative'  // possibilities, hypotheticals, creativity

export interface IIndexable<T> { [key: string]: T }

export type QuizDimension = {
  name: string,
  negative: string,
  positive: string
}

export type Quiz = {
  id: string,
  title: string,
  description: string,
  creator_id: number,
  created_at: number,
  cost: number,
  image?: string,
  dimensions?: QuizDimension[], // JSON array of dimensions in x,y,z,n format
  scoring?: string, // scoring_method for llms
  result_categories?: string[], // JSON array of result types/categories
  token_id?: string,
  published: boolean
}

export interface QuizOption {
  text: string
  dimension_weights: number[][] // JSON array of dimension weights
}

export type QuizQuestion = {
  id: number,
  quiz_id: string,
  q_id: string,      // question id
  stem: string,      // question text
  question_order: number,
  type: QueryType,
  allows_text: boolean, // whether free text answers are allowed as fallback
  options?: QuizOption[],
  dimension_weights?: number[][] // JSON array of dimension weights
}



//// Database Raw Response Types ////
export type Topic = {
  id: number
  name: string
  description?: string
  created_at: number
  parent_id?: number
}

export type QueryTopic = {
  query_id: string
  topic_id: number
}

//// Topic Analytics Types ////
export type TopicMetrics = {
  topic_id: number
  // Volume metrics
  total_questions: number
  total_answers: number
  total_contributors: number
  // Time-windowed metrics
  questions_24h: number
  questions_7d: number
  questions_30d: number
  // Growth rates (percentages)
  growth_rate_24h: number
  growth_rate_7d: number
  growth_rate_30d: number
  // Engagement metrics
  avg_answers_per_question: number
  total_likes: number
  total_recasts: number
  engagement_rate: number
  // Composite score
  momentum_score: number
  trend_direction: 'rising' | 'falling' | 'stable'
  // Timestamps
  last_updated: number
}

export type TopicWithMetrics = Topic & TopicMetrics

export type TimeSeriesPoint = {
  timestamp: number
  questions_count: number
  answers_count: number
  likes_count: number
  recasts_count: number
}

export type TopicRelation = {
  topic_id_1: number
  topic_id_2: number
  co_occurrence_count: number
}

export type TopicListOptions = {
  limit?: number
  offset?: number
  sortBy?: 'momentum' | 'recent' | 'popular' | 'alphabetical'
  timeWindow?: '24h' | '7d' | '30d' | 'all'
}

export type TopicListResult = {
  topics: TopicWithMetrics[]
  total: number
  limit: number
  offset: number
}

export type DBUser = Omit<User, 'socials'> & {
  socials: string // JSON string of Social[]
}

// export type DBQuery = Omit<Query, 'a_options' | 'tags' | 'reqs' | 'assets' | 'scale_config'> & {
//   a_options: string | null // JSON string of string[]
//   tags: string | null // JSON string of string[]
//   reqs: string | null // JSON string of string[]
//   assets: string | null // JSON string of string[]
//   scale_config: string | null // JSON string of ScaleConfig
// }

// export type DBAnswer = Omit<Answer, 'allowlist'> & {
//   allowlist: string | null // JSON string of string[]
// }

// Parse helpers with type safety
// export const parseDBQuery = (dbQuery: DBQuery): Query => {
//   return {
//     ...dbQuery,
//     a_options: dbQuery.a_options ? JSON.parse(dbQuery.a_options) : undefined,
//     tags: dbQuery.tags ? JSON.parse(dbQuery.tags) : undefined,
//     reqs: dbQuery.reqs ? JSON.parse(dbQuery.reqs) : undefined,
//     assets: dbQuery.assets ? JSON.parse(dbQuery.assets) : undefined,
//     scale_config: dbQuery.scale_config ? JSON.parse(dbQuery.scale_config) : undefined,
//   }
// }

// export const parseDBAnswer = (dbAnswer: DBAnswer): Answer => {
//   return {
//     ...dbAnswer,
//     allowlist: dbAnswer.allowlist ? JSON.parse(dbAnswer.allowlist) : undefined,
//   }
// }

export const parseDBUser = (dbUser: DBUser): User => {
  return {
    ...dbUser,
    socials: dbUser.socials ? JSON.parse(dbUser.socials) : undefined,
  }
}


// Add DB types for Quiz and QuizQuestion
export type DBQuiz = Omit<Quiz, 'dimensions' | 'result_categories'> & {
  dimensions: string | null // JSON string of string[]
  result_categories: string | null // JSON string of string[]
}

export type DBQuizQuestion = Omit<QuizQuestion, 'options' | 'dimension_weights'> & {
  options: string | null, // JSON string of QuizOption[]
  dimension_weights: string | null // JSON string of dimension weight mapping
}

// Add parse helpers
export const parseDBQuiz = (dbQuiz: DBQuiz): Quiz => {
  return {
    ...dbQuiz,
    dimensions: dbQuiz.dimensions ? JSON.parse(dbQuiz.dimensions) : undefined,
    result_categories: dbQuiz.result_categories ? JSON.parse(dbQuiz.result_categories) : undefined,
  }
}

export const parseDBQuizQuestion = (dbQuizQuestion: DBQuizQuestion): QuizQuestion => {
  return {
    ...dbQuizQuestion,
    options: dbQuizQuestion.options ? JSON.parse(dbQuizQuestion.options) : undefined,
    dimension_weights: dbQuizQuestion.dimension_weights ? JSON.parse(dbQuizQuestion.dimension_weights) : undefined,
  }
}

//// token transactions ////
export type TokenTransaction = {
  id: string,
  from_id: number,
  to_id: number,
  amount: number,
  token_type: 'QP' | 'QQ',
  reason: 'query_creation' | 'query_answer' | 'quiz_creation' | 'direct_query' | 'conversion' | 'other',
  created_at: number,
  reference_id?: string       // Related entity ID (query/quiz)
}

// Add validation types for current answer types
export interface AnswerValidation {
  mc: (value: string, options: QuizOption[]) => boolean    // Check if value matches an option
  text: (value: string) => boolean                         // Always valid
  scale: (value: string, options: QuizOption[]) => boolean // Check if within scale range
  // date: (value: string) => boolean                         // Check ISO date format
  // url: (value: string) => boolean                          // Check URL validity
}

// Add display formatting for current answer types
export interface AnswerDisplay {
  mc: (value: string, options: QuizOption[]) => string    // Show selected option text
  text: (value: string) => string                         // Show as is
  scale: (value: string, options: QuizOption[]) => string // Show scale value and label
  //   date: (value: string) => string                         // Format date for display
  //   url: (value: string) => string                          // Format URL for display
}

//// Neynar Signer Types ////

/**
 * Represents a Neynar-managed signer for Farcaster actions
 * Signers allow apps to perform actions on behalf of users
 */
export interface NeynarSigner {
  /** Always 'signer' for Neynar signer objects */
  object: 'signer';
  /** Unique identifier for this signer */
  signer_uuid: string;
  /** Public key of the signer (Ed25519) */
  public_key: string;
  /** Current status of the signer */
  status: 'pending_approval' | 'approved' | 'revoked';
  /** URL for user to approve signer (only present when pending) */
  signer_approval_url?: string;
  /** Farcaster ID (FID) this signer is authorized for */
  fid: number;
  /** Permissions granted to this signer */
  permissions?: string[];
}

/**
 * Response when creating or registering a signer
 */
export interface SignerResponse {
  signer_uuid: string;
  public_key: string;
  status: string;
  signer_approval_url?: string;
  fid?: number;
}

/**
 * Request to register a signed key with the Farcaster protocol
 */
export interface RegisterSignedKeyRequest {
  signer_uuid: string;
  public_key: string;
  app_fid: number;
  deadline: number;
  signature: string;
}

/**
 * Sign-In with Farcaster (SIWF) message structure
 */
export interface SIWFMessage {
  message: string;
  signature: string;
  nonce: string;
  fid?: number;
}
