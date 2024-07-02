// const BASE_URL = 'https://api.airstack.xyz/graphql'
// import { gql, GraphQLClient } from "graphql-request"
import {
  init,
  fetchQuery
} from "@airstack/airstack-react"
import { AIRSTACK_API_KEY } from "./key"

init(AIRSTACK_API_KEY, { env: "prod" })

interface FarcasterValidateFrameMessage {
  "isValid": boolean,
  "message": {
    "data": {
      "fid": number,
      "frameActionBody": {
        "buttonIndex": number,
        "castId": {
          "fid": number,
          "hash": string
        },
        "inputText": string,
        "state": string
      }
    }
  },
  "interactedByFid": number,
  "interactedBy": {
    "profileName": string
  },
  "castedByFid": number,
  "castedBy": {
    "profileName": string
  }
}

interface ValidateActionResponse {
  "isValid": boolean,
  "message": {
    "data": {
      "frameActionBody": {
        "castId": {
          "hash": string
        }
        "address": string
      }
      "fid": number
    }
  },
  "interactedByFid": number
  "castedByFid": number
}

// interface Error {
//   message: string;
// }

export async function getFarcasterProfileName(fid: number) {
  const query = `
    query MyQuery($userId: String!) {
      Socials(
        input: { filter: { userId: { _eq: $userId } }, blockchain: ethereum }
      ) {
        Social {
          profileName
        }
      }
    }
  `

  const { data, error } = await fetchQuery(query, { userId: fid?.toString() })
  const profileName = data.Socials.Social[0].profileName
  return { profileName, error }
}

export async function getProfileDataFromFid(fid: number) {
  const query = `
    query MyQuery($userId: String!) {
      Socials(
        input: {filter: { userId: {_eq: $userId}}, blockchain: ethereum}
      ) {
        Social {
          profileName
          profileImage
        }
      }
    }
  `

  const { data, error } = await fetchQuery(query, { userId: fid?.toString() })
  if (error) console.log('error?', error)
  const profileData = {
    profileName: data.Socials.Social[0].profileName,
    image: data.Socials.Social[0].profileImage
  }
  return { profileData, error }
}



export async function getProfileDataFromName(profileName: string) {
  const query = `
    query MyQuery($profileName: String!) {
      Socials(
        input: {filter: {profileName: {_eq: $profileName}}, blockchain: ethereum}
      ) {
        Social {
          profileTokenId
          profileImage
        }
      }
    }
  `

  const { data, error } = await fetchQuery(query, { profileName: profileName })
  console.log(profileName, data)
  if (error) console.log('error?', error)
  const profileData = {
    fid: data.Socials.Social[0].profileTokenId,
    image: data.Socials.Social[0].profileImage
  }
  return { profileData, error }
}

export async function validateAction(messageBytes: string): Promise<ValidateActionResponse> {
  const query = `
    query MyQuery($messageBytes: String!) {
      FarcasterValidateFrameMessage(input: {filter: {messageBytes: $messageBytes}}) {
        isValid
        message {
          data {
            frameActionBody {
              castId {
                hash
              }
            }
            fid
          }
        }
        interactedByFid
        castedByFid
      }
    }
  `

  const { data, error } = await fetchQuery(query, { messageBytes: messageBytes })
  if (error) {
    console.log('avdErr', error)
    // throw error
  }
  console.log('avd', data)
  return data.FarcasterValidateFrameMessage as ValidateActionResponse
}


export async function getValidFrameMessageDetails(messageBytes: string): Promise<FarcasterValidateFrameMessage> {
  const query = `
    query MyQuery($messageBytes: String!) {
      FarcasterValidateFrameMessage(
        input: {filter: {messageBytes: {_eq : $messageBytes}}}) {
        isValid
        message {
          data {
            fid
            frameActionBody {
              buttonIndex
              castId {
                fid
                hash
              }
              inputText
              state
            }
          }
        }
        interactedByFid
        interactedBy {
          profileName
        }
        castedByFid
        castedBy {
          profileName
        }
      }
    }
  `


  const { data, error } = await fetchQuery(query, { messageBytes: messageBytes })
  if (error) {
    console.log('error fetching airstack data', error)
    throw Error(error)
  }
  return data.FarcasterValidateFrameMessage
}

type CastData = {
  castText: string,
  castTimestamp: string
}

export async function getCastData(messageBytes: string): Promise<CastData> {
  const query = `
    query MyQuery($messageBytes: String!) {
      FarcasterCasts(input: {blockchain: ALL, filter: {hash: {_eq: $messageBytes}}}) {
        Cast {
          text
          castedAtTimestamp
        }
      }
    }
  `

  const { data, error } = await fetchQuery(query, { messageBytes: messageBytes })
  if (error) {
    console.log('error fetching castData from airstack', error)
    throw Error(error)
  }
  const castText = data.FarcasterCasts.Cast[0].text
  const castTimestamp = data.FarcasterCasts.Cast[0].castedAtTimestamp
  return { castText, castTimestamp }
}

export type Wallet = {
  address: string,
  blockchain: string
}

export type ProfileData = {
  profileName: string,
  image: string,
  wallets: Wallet[]
}

export type ProfileDataResponse = {
  profileData: ProfileData,
  error: Error
}

export async function getConnectedAddressesFromFid(fid: number): Promise<ProfileDataResponse> {
  const query = `
    query MyQuery($userId: String!) {
      Socials(
        input: {filter: { userId: {_eq: $userId}}, blockchain: ethereum}
      ) {
        Social {
          profileName
          profileImage
          connectedAddresses {
            address
            blockchain
          }
        }
      }
    }
  `

  const { data, error } = await fetchQuery(query, { userId: fid?.toString() })
  if (error) console.log('profileData error', error)
  const profileData = {
    profileName: data.Socials.Social[0].profileName,
    image: data.Socials.Social[0].profileImage,
    wallets: data.Socials.Social[0].connectedAddresses
  }
  return { profileData, error }
}

// `query MyQuery {
//   FarcasterCasts(input: {blockchain: ALL, filter: {castedBy: {_eq: "fc_fname:vitalik.eth"}}}) {
//     Cast {
//       id
//       fid
//       text
//       rawText
//       parentFid
//       hash
//       rootParentHash
//       rootParentUrl
//       parentHash
//       parentUrl
//       url
//       castedAtTimestamp
//       castedBy {
//         profileName
//       }
//       parentCast {
//         id
//         fid
//         text
//         rawText
//         parentFid
//         hash
//         rootParentHash
//         rootParentUrl
//         parentHash
//         parentUrl
//         url
//         castedAtTimestamp
//         castedBy {
//           profileName
//         }
//       }
//     }
//   }
// }`





// interface Wallet {
//   socials: Social[];
//   addresses: string[];
// }

// interface Social {
//   dappName: "lens" | "farcaster";
//   profileName: string;
// }

// const AIRSTACK_API_URL = "https://api.airstack.xyz/graphql"

// const graphQLClient = new GraphQLClient(AIRSTACK_API_URL, {
//   headers: {
//     Authorization: AIRSTACK_API_KEY, // Add API key to Authorization header
//   },
// })


// export const getValidFrameMessageDetails = async ($messageBytes: string) => {
//   const query = gql`
//     query MyQuery($messageBytes: String!) {
//       FarcasterValidateFrameMessage(input: {filter: {messageBytes: ${$messageBytes}}}) {
//         isValid
//         message {
//           data {
//             fid
//             frameActionBody {
//               buttonIndex
//               castId {
//                 fid
//                 hash
//               }
//               inputText
//               state
//             }
//           }
//         }
//         interactedByFid
//         interactedBy {
//           profileName
//         }
//         castedByFid
//         castedBy {
//           profileName
//         }
//       }
//     }
//   `

//   try {
//     const data = await graphQLClient.request<Data>(query)
//     console.log(data)
//     const returnData = data.FarcasterValidateFrameMessage
//     return returnData
//   } catch (e) {
//     throw new Error((e as Error)?.message + 'boop')
//   }
// }
// const options: RequestInit<RequestInitCfProperties> = {
//   cf: {
//     cacheTtl: 3600,
//     // Relevant for fetching a user's pfp
//     // Must have transformations enabled for the Cloudflare zone: https://developers.cloudflare.com/images/get-started/#enable-transformations
//     image: {
//       width: 512,
//       height: 512,
//       fit: 'cover',
//     },
//   },
// }

// export async function getFidFromUsername(username: string) {
//   const res = await fetch(
//     `${BASE_URL}/v1/userNameProofByName?name=${username}`,
//     options
//   )

//   const data = (await res.json()) as {
//     timestamp: number
//     name: string
//     owner: string
//     signature: string
//     fid: number
//     type: string
//   }

//   return data.fid
// }

// export async function getEthAddressFromFid(fid: number) {
//   const res = await fetch(
//     `${BASE_URL}/v1/verificationsByFid?fid=${fid}`,
//     options
//   )

//   const data = (await res.json()) as {
//     messages: Array<{
//       data: {
//         type: string
//         fid: number
//         timestamp: number
//         network: string
//         verificationAddAddressBody: {
//           address: string
//           claimSignature: string
//           blockHash: string
//           verificationType: number
//           chainId: number
//           protocol: 'PROTOCOL_SOLANA' | 'PROTOCOL_ETHEREUM'
//           ethSignature: string
//         }
//       }
//     }>
//   }

//   const ethAddresses = data.messages.filter(
//     (message) =>
//       message.data.verificationAddAddressBody.protocol === 'PROTOCOL_ETHEREUM'
//   )

//   return ethAddresses[0].data.verificationAddAddressBody.address
// }

// export async function getUserDataByFid(fid: number, type: number) {
//   const res = await fetch(
//     `${BASE_URL}/v1/userDataByFid?fid=${fid}&user_data_type=${type}`,
//     options
//   )

//   const data = (await res.json()) as {
//     data: {
//       type: string
//       fid: number
//       timestamp: number
//       network: string
//       userDataBody: {
//         type: string
//         value: string
//       }
//     }
//     hash: string
//     hashScheme: string
//     signature: string
//     signatureScheme: string
//     signer: string
//   }

//   return data.data.userDataBody.value
// }
