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
} from '../../api/db/bagel'
import {
  AddDocResponse,
  QEntry,
  Q,
  User
} from '../../api/db/types'
import { CustomFrameContext, State } from './index'
import { chargeUserForQCoining, getOrCreateUser } from '../../api/db/d1'
// import { tokenize } from '../../api/llm/tokenize'
// import { v4 as uuidv4 } from 'uuid'
import { getFarcasterProfileName } from '../../api/airstack/hub'
import { qbaseVersion } from '../../api/db/bagel'
// import { AiTextEmbeddingsOutput } from '@cloudflare/ai/dist/ai/tasks/text-embeddings'


const modelName = 'baai/bge-base-en-v1.5'


export const coinSuccessScreen: FrameHandler = async (c: CustomFrameContext) => {
  //// frame data ////
  const { frameData, previousState } = c

  // const messageHash = frameData?.messageHash as string
  const qfid = frameData?.fid as number
  const statefulState = previousState as State
  const { q } = statefulState


  //// fc userdata from airstack ////
  // get farcaster user details for sender
  // const input: FarcasterUserDetailsInput = {
  //   fid: qfid
  // }
  // const { data, error }: FarcasterUserDetailsOutput = await getFarcasterUserDetails(input)
  // if (error) throw new Error(error)
  const { profileName, error } = await getFarcasterProfileName(qfid)
  if (error) console.log('airstackError', error)
  // const profileName = data.Socials.Social[0].profileName

  //// add to DBs ////
  // userDB
  let coiner: User = await getOrCreateUser(qfid, c.env.DB)
  // charge points?

  // bagelDB
  if (coiner.points_balance < 2) {
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
            <text>Phase 2 coming soon™</text>
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
              >v0.1.0</text>
            </div>
          </div>
        </div>
      ),
      imageOptions: { width: 1200, height: 1200 },
      imageAspectRatio: '1:1',
      intents: [
        <Button.Reset>Back</Button.Reset>,
        <Button action='/coinedQs'>See Qs</Button>
      ]
    })
  }

  const qCount = await getCount(c.env)
  const timestamp = Date.now()
  const nextQCount = qCount + 1
  const qMetadata: Q[] = [
    {
      id: nextQCount.toString(),
      created_at: timestamp,
      coiner_name: profileName,
      coiner_id: coiner.id,
      coiner_fid: qfid.toString(),
      model: modelName
    }
  ]
  const qToAdd: QEntry = {
    metadatas: qMetadata,
    documents: [q as string]
  }
  const deductedPoints = await chargeUserForQCoining(coiner, c.env.DB)
  if (deductedPoints) {
    const qBaseResult: AddDocResponse = await addDocEntry(qToAdd, c.env)
    if (qBaseResult !== true) {
      console.log('qBaseResultError:', qBaseResult)
      throw new Error(qBaseResult.detail[0].msg)
    }
  }

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
              coined by {profileName}
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
              Your points: {coiner.points_balance - 2}
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
      <Button action='/coinedQs'>see qs</Button>,
      <Button.Link href={linkUrl}>share</Button.Link>
    ]
  })
}

