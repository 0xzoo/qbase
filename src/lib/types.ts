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
  /** Default visibility/audience preference for questions */
  defaultQuestionAudience: Audiences;
  /** Theme preference */
  theme?: 'light' | 'dark' | 'auto';
  /** Notification preferences */
  notifications?: {
    directQuestions?: boolean;
    answers?: boolean;
    reactions?: boolean;
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
  TEXT: "text",
  SCALE: "scale",
  SCALE_RANGE: "scale_range"
} as const

export type QueryType = typeof QueryType[keyof typeof QueryType]

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
  step: number;
  showNumericValue?: boolean;
  customLabels?: {
    value: number;
    label: string;
  }[];
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
  casthash?: string,
  assets?: string[],
  owner_id: number | { '%allot': number },
  token_id?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  cost: number,
  template?: boolean,
}

// QuerySubmission is what comes from the frontend
export type QuerySubmission = {
  stem: string,
  type: QueryType,
  coiner_id: number,
  coiner_fname?: string,
  coiner_fid?: number,
  a_options?: string[],
  scale_config?: ScaleConfig,
  casthash?: string,
  assets?: string[],
  token_id?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  cost?: number,
  isAnon?: boolean,
  template?: boolean,
}

export type EncryptedQuerySubmission = Omit<QuerySubmission, 'coiner_id'> & {
  coiner_id: number | { '%allot': number },
  token_id?: string,
  a_options?: string[],
  scale_config?: ScaleConfig,
  casthash?: string,
  tags?: string[],
  parent?: string,
  reqs?: string[],
  assets?: string[],
  template?: boolean,
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
  /** NFT Token ID if minted */
  token_id?: string,
  /** Array of answer options for MC questions (JSON string in DB) */
  a_options?: string[],
  /** Configuration for scale-type questions */
  scale_config?: ScaleConfig,
  /** Farcaster cast hash if published to Farcaster */
  casthash?: string,
  /** Tags associated with the query */
  tags?: string[],
  /** ID of the parent query if this is a fork */
  parent?: string,
  /** Requirements/Gating criteria */
  reqs?: string[],
  /** Attached assets (images, etc.) */
  assets?: string[]
  /** Whether this query is a template */
  template?: boolean
  /** Multi-dimensional taxonomy classification */
  taxonomy?: QuestionTaxonomy
}

/**
 * Multi-dimensional taxonomy for question classification.
 * See docs/question-taxonomy.md for full specification.
 */
export type QuestionTaxonomy = {
  /** Primary type - determines storage (identity_answers vs recurring_answers vs prospective_answers) */
  primary_type: 'identity' | 'recurring' | 'prospective';
  /** Construction type - how the question is structured */
  construction_type: 'complete' | 'template' | 'follow_up';
  /** Content tags - what the question captures (can have multiple) */
  content_tags: Array<'belief' | 'preference' | 'behavioral' | 'demographic'>;
  /** Sensitivity level - privacy implications */
  sensitivity: 'low' | 'medium' | 'high';
  /** Temporal markers found in the question (if recurring) */
  temporal_markers?: string[];
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
  /** The answer content. String for text, object for complex types */
  value: string | object,
  /** ID of the answer type schema */
  answer_type_id: string,
  /** ID of the suggested answer type schema */
  suggested_answer_type_id: string,

  /** Privacy setting for the answer (Public, Private, etc.) */
  audience: Audiences,
  /** Whether the answer has been edited */
  edited: boolean,
  /** Index of the selected option (for MC questions) */
  q_index?: number,
  /** URI of attached asset */
  asset?: string,
  /** Farcaster cast hash if the answer was casted */
  casthash?: string,
  /** Farcaster cast hash of the parent cast (query) */
  parent_casthash?: string,
  /** List of FIDs allowed to view the answer (for Allowlist audience) */
  allowlist?: string[],

}

export type AnswerEntry = {
  id: string,
  q_id: string,
  user_id: number | { '%allot': number },
  value: string | object | { '%allot': string },
  answer_type_id: string,
  suggested_answer_type_id: string,

  audience: Audiences,
  edited: boolean,
  q_index?: number | { '%allot': number },
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
