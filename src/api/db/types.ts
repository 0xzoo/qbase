//// postgres ////
export type Social = "x" | "farcaster" | "github"

export type User = {
  id: number,
  fid?: number,
  fname?: string,
  created_at: number,
  points_balance: number,
  points_allowance: number,
  q_cost?: number,
  socials?: { social: Social, value: string }[]
}

export type DirectQ = {
  id?: number,
  sender_id: number,
  recipient_id: number,
  q_id: string,
  sent_at?: number,
  answered?: boolean,
  removed?: boolean,
  cost?: number,
  tx?: string,
  cast?: Cast
}

export type Cast = {
  url: string // Text can be up to 320 bytes long
}

export type Answer = { // will need bot for this
  id: string,
  qid: string,
  userId: string,
  text: string,
  timestamp: number,
  isPrivate: boolean,
  qIndex?: number,
  casts?: Cast[],
  'bagel:document'?: string,
  'bagel-doc_type'?: string
}

//// bagelDB ////
export type Q = {
  id: string,
  'bagel:document'?: string,
  'bagel-doc_type'?: string,
  coiner_id: number,
  coiner_name: string,
  coiner_fid?: string,
  minted?: boolean,
  owner_id?: number,
  created_at: number,
  responses?: number,
  ogCast?: Cast,
  model?: string
}

// add
export type Metadata = { [key: string]: string | number }
export type Embeddings = any[]
export type Document = string
export type AddDocResponse = true | ValidationError

export type QEntry = {
  "embeddings"?: Embeddings | null,
  "metadatas"?: Q[] | null,
  "documents"?: Document[] | null,
  "uris"?: Document[] | null,
  "ids"?: string[], // required for api call
}

// query
export type QueryInclude = "metadatas" | "documents" | "distances"

export type QQuery = {
  "where"?: {} | null, // default {}
  "where_document"?: {} | null, // default {}
  "query_embeddings"?: Embeddings | null,
  "n_results"?: number, // default 10
  "include"?: QueryInclude[] // default ["metadatas", "documents", "distances"]
  "query_texts"?: string[] | null,
  "padding"?: boolean // default false
}

export type QQueryResponse = {
  ids: string[][] | null,
  distances: number[][] | null,
  metadatas: Q[][] | null,
  embeddings: any[][][] | null,
  documents: string[][] | null,
  data: any | null
}

// get
export type GetQQuery = {
  "ids"?: string[] | null,
  "where"?: Metadata | null,
  "where_document"?: any | null,
  "sort"?: string | null,
  "limit"?: number | null,
  "offset"?: number | null,
  "include"?: string[] | null
}

export type GetQResponse = {
  ids: string[] | null,
  metadatas: Q[] | null,
  embeddings: any[] | null,
  documents: string[] | null,
  uris: string[] | null
  data: any | null
}


// Validation error
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

//// other ////
// export type Rarity = "SS" | "S" | "A" | "B" | "C" | "D" | "F"
export type Rarity = "Rare" | "Common" | "Normie"