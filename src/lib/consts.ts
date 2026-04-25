//// constraints ////
export const MAX_CAST_LENGTH = 320
export const MAX_CAST_LENGTH_PRO = 10000
export const MAX_Q_LENGTH = 320
export const MAX_A_LENGTH = 10000
export const MESSAGE_EXPIRATION_TIME = 1000 * 60 * 60 * 24 * 30 // 30 days

//// 4n0n - Anonymous Bot Account ////
// The anon bot (@4n0n, FID 514282) is used for posting anonymous content to Farcaster
// Real authorship is stored in D1 via HiddenLink records
export const anon_id = 3
export const anon_fname = "4n0n"
export const anon_fid = 514282
export const anon_bot_username = "@4n0n"  // Display name for UI

//// qbase ////
export const qbaseURL = 'https://qbase.tech'
export const qbaseVersion = 'v0.2.0'
export const qbaseLogoURL = 'https://github.com/0xzoo/qbase/raw/d96e80d2e0a9073e2462d0a2019af70c87164b59/public/logo.png'
// export const modelName = 'baai/bge-base-en-v1.5'
export const appName = 'qbase'
export const splashImageUrl = `${qbaseURL}/splash.png`
export const iconUrl = `${qbaseURL}/icons/96x96.png`

//// @polls - Poll Bot Account ////
// The polls bot (@polls, FID 3321680) is used for casting polls to Farcaster
export const polls_fid = 3321680
export const polls_fname = "polls"
export const polls_bot_username = "@polls"  // Display name for UI

//// $qq ////
export const QQ_COIN_ADDRESS = '0x7d39833d9d5baa835ba19e964e4ba114521ccfe4'

// costs //
export const q_cost = 10
export const default_dq_cost = 10
export const answer_cost = 2
export const mint_cost = 0.003
export const tip_cost = 5
export const unlock_cost = 20

// vector search thresholds //
export const SIMILARITY_THRESHOLD = 0.85  // For recommendations - show similar questions
export const DUPLICATE_THRESHOLD = 0.98   // For duplicate prevention - block near-identical

// // styles
// export const smW = '100%'
export const mdW = 500
export const lW = 700
// export const wArray = [smW, mdW, lW]
export const wClasses = `w-full md:w-[${mdW}px] lg:w-[${lW}px]`
// export const Colors = {
//   indigo: "#19285B",
//   current: "#216869",
//   jungle: "#49a078",
//   cambridge: "#ADCEB1",
//   platinum: "#EFF3E1"
// }