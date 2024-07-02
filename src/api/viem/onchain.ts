import { publicClient } from './client'
import { abi } from './abi'

export const qNFTContractAddress = '0xe9a98595c127edd894c899bacd4ecef9780b444f' // TODO: change this

export const getTokenText = async (tokenId: string) => {
  try {
    const tokenText = await publicClient.readContract({
      address: qNFTContractAddress,
      args: [tokenId],
      abi: abi,
      functionName: 'getText',
    })

    return tokenText
  } catch (error) {
    console.log(error)
    return null
  }
}

// TODO: change this to db call? for version value
export const getTokenMetadata = async (tokenId: string) => {
  try {
    const tokenText = await getTokenText(tokenId)
    if (tokenText) {
      const metadata = {
        "name": "qNFT",
        "description": "onchain questions, queries, and prompts",
        "external_url": "https://warpcast.com/~/channel/qbase",
        "image": "https://qbase.tech/q/" + tokenId.toString() + "/img.png",
        "text": tokenText,
        "attributes": [
          {
            "trait_type": "version",
            "value": "1.0"
          }
        ]
      }

      return JSON.stringify(metadata)
    } else {
      return "Nonexistent token ID " + tokenId
    }
  } catch (error) {
    return "Error retrieving metadata for token ID " + tokenId + ": " + error
  }
}