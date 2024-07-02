import {
  Button,
  FrameHandler,
} from 'frog'
import { CustomFrameContext, State } from '.'
import {
  getCastData,
  // getFarcasterProfileName, 
  validateAction
} from '../../api/airstack/hub'
// import { 
//   // chargeUser, 
//   // getOrCreateUser, 
//   // payUser 
// } from '../../api/db/d1'
import {
  // AddDocResponse, 
  // Q, 
  // QEntry, 
  QQueryResponse
} from '../../api/db/types'
import {
  // addDocEntry, 
  // getCount, 
  queryForSimilar
} from '../../api/db/bagel'
import { successScreen } from '../components/successScreen'
import { errorScreen } from '../components/errorScreen'


const mintScreen: FrameHandler = async (c: CustomFrameContext) => {
  const body = await c.req.json()
  const messageBytes = body.trustedData.messageBytes

  const {
    isValid,
    message,
    interactedByFid,
    castedByFid
  } = await validateAction(messageBytes)
  if (isValid) {
    const castHash = message.data.frameActionBody.castId.hash
    // const coiner = await getOrCreateUser(interactedByFid, c.env.DB)
    // if not enough qp, no dice
    // TODO: change when users can spend pa and pb, balance -> allowance
    // if (coiner.points_balance < 2) return c.res({
    //   image: (
    //     errorScreen(
    //       `you dont have enough $qp :(`
    //     )
    //   ),
    //   intents: [
    //     <Button.Reset>Back</Button.Reset>
    //   ]
    // })

    // const trueCoiner = await getOrCreateUser(castedByFid, c.env.DB)
    const {
      castText,
      castTimestamp
    } = await getCastData(castHash)

    //// give og caster a 1 min window to mint
    const now = Date.now()
    const timestamp = new Date(castTimestamp).getMilliseconds()
    var diff = Math.abs(now - timestamp)
    var minSinceCast = Math.floor((diff / 1000) / 60)
    if (minSinceCast < 1 && interactedByFid !== castedByFid) {
      return c.res({
        image: (
          errorScreen(
            `caster has a 1 min window to mint...`, `please wait and try again`
          )
        ),
        intents: [
          <Button.Reset>Back</Button.Reset>
        ]
      })
    }

    //// search for similars
    console.log('castText', castText)
    const qSimilars: QQueryResponse = await queryForSimilar(castText as string, c.env)
    const nearestSimilar = qSimilars.distances && qSimilars.distances[0][0] as number

    // check for previous qs
    let alreadyCoined: boolean
    if (nearestSimilar == null) {
      return c.error({ message: 'trouble connecting to db. please try again', statusCode: 400 })
    } else if (nearestSimilar > .99) {
      alreadyCoined = true
    } else {
      alreadyCoined = false
    }

    // const mintQNFT = async() => {
    //   const qCount = await getCount(c.env)
    //   const timestamp = Date.now()
    //   const nextQCount = qCount + 1
    //   const { profileName } = await getFarcasterProfileName(interactedByFid)
    //   const qMetadata: Q[] = [
    //     {
    //       id: nextQCount.toString(),
    //       created_at: timestamp,
    //       coiner_name: profileName,
    //       coiner_id: trueCoiner.id,
    //       coiner_fid: trueCoiner.fid?.toString(),
    //       owner_id: coiner.id
    //     }
    //   ]
    //   const qToAdd: QEntry = {
    //     metadatas: qMetadata,
    //     documents: [castText]
    //   }
    //   const deductedPoints = await chargeUser(coiner, 'coin', c.env.DB)
    //   if (deductedPoints) {
    //     const qBaseResult: AddDocResponse = await addDocEntry(qToAdd, c.env)
    //     if (qBaseResult !== true) {
    //       throw new Error(qBaseResult.detail[0].msg)
    //     }
    //   }
    //   return c.res({
    //     image: (
    //       successScreen(
    //         `you coined this q!`
    //       )
    //     ),
    //     intents: [
    //       <Button.Reset>Back</Button.Reset>
    //       // TODO: add button for my qs
    //     ]
    //   })
    // }

    if (alreadyCoined) {
      // check if already minted
      const alreadyMinted = qSimilars.metadatas && qSimilars.metadatas[0][0].minted
      if (alreadyMinted) {
        return c.res({
          image: (
            errorScreen(
              `already minted 😲` //, `you tipped @${trueCoiner.fname} 1 $qp`
            )
          ),
          imageOptions: { width: 1200, height: 630 },
          intents: [
            <Button.Reset>Back</Button.Reset>
          ]
        })
      } else {
        const { deriveState } = c
        deriveState(previousState => {
          let newState: State = previousState as State
          newState.qToMint = castText as string
        })
        return c.res({
          image: (
            successScreen(
              `this q is unowned. mint it now?`
            )
          ),
          imageOptions: { width: 1200, height: 630 },
          intents: [
            <Button.Reset>Back</Button.Reset>,
            <Button.Transaction target='/mint' action='/mint/finish'>Mint with Wallet</Button.Transaction>
          ]
        })
      }
    } else {
      const { deriveState } = c
      deriveState(previousState => {
        let newState: State = previousState as State
        newState.qToMint = castText as string
      })
      return c.res({
        image: (
          successScreen(
            `this q is unowned. mint it now?`
          )
        ),
        imageOptions: { width: 1200, height: 630 },
        intents: [
          <Button.Reset>Back</Button.Reset>,
          <Button.Transaction target='/mint' action='/mint/finish'>Mint with Wallet</Button.Transaction>
        ]
      })
    }
  } else {
    return c.res({
      image: (
        errorScreen(
          `action is invalid. try again` // TODO: dont try again lol
        )
      ),
      imageOptions: { width: 1200, height: 630 },
      intents: [
        <Button.Reset>Back</Button.Reset>
      ]
    })
  }
}

export default mintScreen