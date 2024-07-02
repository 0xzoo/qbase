import {
  Button,
  FrameHandler
} from 'frog'
import { CustomFrameContext } from '.'
import { successScreen } from '../components/successScreen'
import { addDocEntry, getCount } from '../../api/db/bagel'
import { getCastData, getFarcasterProfileName, validateAction } from '../../api/airstack/hub'
import { getOrCreateUser } from '../../api/db/d1'
import { AddDocResponse, Q, QEntry } from '../../api/db/types'

const mintFinishScreen: FrameHandler = async (c: CustomFrameContext) => {
  const body = await c.req.json()
  const messageBytes = body.trustedData.messageBytes
  const {
    message,
    interactedByFid,
  } = await validateAction(messageBytes)
  const castHash = message.data.frameActionBody.castId.hash
  const coiner = await getOrCreateUser(interactedByFid, c.env.DB)
  const qCount = await getCount(c.env)
  const timestamp = Date.now()
  const nextQCount = qCount + 1
  const { profileName } = await getFarcasterProfileName(interactedByFid)
  const qMetadata: Q[] = [
    {
      id: nextQCount.toString(),
      created_at: timestamp,
      coiner_name: profileName,
      coiner_id: coiner.id,
      coiner_fid: coiner.fid?.toString(),
      owner_id: coiner.id
    }
  ]
  const {
    castText,
  } = await getCastData(castHash)
  const qToAdd: QEntry = {
    metadatas: qMetadata,
    documents: [castText]
  }
  const qBaseResult: AddDocResponse = await addDocEntry(qToAdd, c.env)
  if (qBaseResult !== true) {
    console.log(qBaseResult.detail[0].msg)
  }
  return c.res({
    image: (
      successScreen(
        `you minted this q!`
      )
    ),
    imageOptions: { width: 1200, height: 630 },
    intents: [
      <Button.Reset>back</Button.Reset>
    ]
  })
}

export default mintFinishScreen