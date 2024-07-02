import {
  Button,
  FrameHandler
} from 'frog'
import {
  backgroundStyles,
  coinerStyles,
  // colors,
  headerStyles,
  headerTextDataStyles,
  headerTextStyles,
  qContainerStyles,
  qDataStyles,
  qNoDataStyles,
  qStyles,
  screenStyles,
  similarQsStyles
} from '../../styles'
import {
  addDocEntry,
  getCount,
  getQById,
} from '../../api/db/bagel'
import {
  // AddDocResponse,
  QEntry,
  Q,
  User,
  // DirectQ,
} from '../../api/db/types'
import { CustomFrameContext, State } from './index'
import { createDirectQ, getOrCreateUser } from '../../api/db/d1'
import { getFarcasterProfileName } from '../../api/airstack/hub'
import { qbaseVersion } from '../../api/db/bagel'


// const modelName = 'baai/bge-base-en-v1.5'
const directQCost = 4

export const amaSuccessScreen: FrameHandler = async (c: CustomFrameContext) => {
  //// frame data ////
  const { frameData, previousState } = c

  // const messageHash = frameData?.messageHash as string
  const qfid = frameData?.fid as number
  const statefulState = previousState as State
  const { q, qid, fid, anon } = statefulState


  //// fc userdata from airstack ////
  // get farcaster user details for sender
  const { profileName, error } = await getFarcasterProfileName(qfid)
  if (error) console.log('airstackError', error)

  //// add to DBs ////
  // userDB
  let sender: User = await getOrCreateUser(qfid, c.env.DB)
  let recipient: User = await getOrCreateUser(fid, c.env.DB)

  // bagelDB
  if (sender.points_balance < directQCost) { // TODO update to deduct from allowance first, then balance
    return c.res({
      image: (
        <div
          style={{
            ...backgroundStyles,
            ...screenStyles
          }}
        >
          <div
            class={'header'}
            style={{
              ...headerStyles
            }}
          ></div>
          <div
            class={'qContainer'}
            style={{
              ...qContainerStyles
            }}
          >
            <text>Sorry, you don't have enough points...</text>
            <text>Daily allowance coming soon™</text>
          </div>
          <div
            class={'dataContainer'}
            style={{
              ...qNoDataStyles,
              marginLeft: '60px'
            }}
          >
            <img
              height='100px'
              width='100px'
              src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
            />
          </div>
          <div
            class={'footer'}
            style={{
              ...headerStyles
            }}
          >
            <div
              style={{
                ...headerTextStyles
              }}
            >
              <text>{Date.now()}</text>
            </div>
            <div
              style={{
                ...headerTextStyles
              }}
            >
              <text>qbase</text>
              <text
                style={{
                  ...headerTextDataStyles
                }}
              >{qbaseVersion}</text>
            </div>
          </div>
        </div>
      ),
      imageOptions: { width: 1200, height: 1200 },
      imageAspectRatio: '1:1',
      intents: [
        <Button.Reset>back</Button.Reset>,
        <Button action={`/${recipient.fname}/qs`}>see qs</Button>,
      ]
    })
  }

  // if q hasnt been coined, chargetocoinq(2) + 1 to recip + 1 to treasury
  // if q has been coined send 2 to coiner, 1 to recip + 1 to treasury
  // createDirectQ
  let directQ
  let nextQCount

  if (qid) { // if q already coined
    const qAdded = await getQById(Number(qid), c.env)
    const qMetadata = (qAdded.metadatas && qAdded.metadatas[0]) as Q
    directQ = await createDirectQ(sender, recipient, qMetadata, anon, c.env.DB)
  } else {
    // coin q 
    // if anon, 4n0n coins for free?
    const qCount = await getCount(c.env)
    const timestamp = Date.now()
    nextQCount = qCount + 1
    const qMetadata: Q[] = [
      {
        id: nextQCount.toString(),
        created_at: timestamp,
        coiner_name: anon ? '4n0n' : profileName,
        coiner_id: anon ? 2 : sender.id,
        coiner_fid: anon ? '272012' : qfid.toString(),
      }
    ]
    const qToAdd: QEntry = {
      metadatas: qMetadata,
      documents: [q as string]
    }

    const qBaseResult = await addDocEntry(qToAdd, c.env)
    if (qBaseResult !== true) {
      console.log('qBaseResultError:', qBaseResult)
      throw new Error(qBaseResult.detail[0].msg)
    } else {
      const qAdded = await getQById(nextQCount, c.env)
      const qMetadata = (qAdded.metadatas && qAdded.metadatas[0]) as Q
      directQ = await createDirectQ(sender, recipient, qMetadata, anon, c.env.DB)
    }
  }

  console.log(directQ ? 'everything shouldve worked' : 'something failed')

  const qFontSize: string = q.length < 30
    ? '6em'
    : q.length < 120
      ? '5em'
      : '4em'

  const urlMain = `https://qbase.tech/q/${nextQCount}/img.png`
  const linkUrl = `https://warpcast.com/~/compose?embeds[]=${urlMain}`

  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...screenStyles
        }}
      >
        <div
          class={'qContainer'}
          style={{
            ...qContainerStyles
          }}
        >
          <h1
            class={'q'}
            style={{
              ...qStyles,
              fontSize: qFontSize
            }}
          >
            {q}
          </h1>
        </div>
        <div
          class={'dataContainer'}
          style={{
            ...qDataStyles,
          }}
        >
          <div
            class={'data'}
            style={{
              ...similarQsStyles,
            }}
          >
            <text
              style={{
                ...coinerStyles
              }}
            >
              asked by {anon ? '4n0n' : profileName}
              <span style={{ fontSize: '.5em', marginLeft: '6px' }}>({qfid})</span>
            </text>
          </div>
          <img
            height='100px'
            width='100px'
            src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
          />
        </div>
        <div
          class={'footer'}
          style={{
            ...headerStyles
          }}
        >
          <div
            style={{
              ...headerTextStyles
            }}
          >
            <text style={{ marginTop: '-10px', fontSize: '2em' }}>
              Your points: {sender.points_balance - 4}
            </text>
          </div>
          <div
            style={{
              ...headerTextStyles
            }}
          >
            <text>qbase</text>
            <text
              style={{
                ...headerTextDataStyles
              }}
            >{qbaseVersion}</text>
          </div>
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 1200 },
    imageAspectRatio: '1:1',
    intents: [
      <Button.Reset>ask another</Button.Reset>,
      <Button action={`/${recipient.fname}/qs`}>see qs</Button>,
      <Button.Link href={linkUrl}>share</Button.Link>
    ]
  })
}

