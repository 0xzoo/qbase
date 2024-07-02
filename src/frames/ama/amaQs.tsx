import {
  Button,
  FrameHandler
} from 'frog'
import {
  backgroundStyles,
  coinerStyles,
  footerTextStyles,
  headerStyles,
  // headerTextDataStyles,
  headerTextStyles,
  qContainerStyles,
  qDataStyles,
  qStyles,
  qbaseVersionStyles,
  screenStyles,
  similarQsStyles,
  squareErrorFooterStyles
} from '../../styles'
import {
  getQById,
  qbaseVersion,
} from '../../api/db/bagel'
import { CustomFrameContext, State } from './index'
import { GetQResponse, Q } from '../../api/db/types'
import { getOrCreateUser, getReceivedDirectQs } from '../../api/db/d1'
import { getProfileDataFromName } from '../../api/airstack/hub'
// import { tokenize } from '../../api/llm/tokenize'

type param = {
  profileName: string
}

export const amaQsScreen: FrameHandler = async (c: CustomFrameContext) => {

  //// frame data ////
  const { deriveState, buttonValue, frameData } = c
  // state //
  const { profileName } = c.req.param() as unknown as param
  const { profileData } = await getProfileDataFromName(profileName)
  const { fid } = profileData
  const interactedByFid = frameData?.fid
  const isOwner = fid == interactedByFid
  const recipient = await getOrCreateUser(fid, c.env.DB)
  const receivedQs = await getReceivedDirectQs(recipient.id, c.env.DB)
  const qCount = receivedQs.length

  // if no received qs
  if (qCount == 0) {
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
              ...qContainerStyles,
              paddingTop: '200px',
              fontSize: '60px'
            }}
          >
            <h1
              class={'q'}
              style={{
                ...qStyles,
                fontSize: '90px'
              }}
            >
              {isOwner ? 'your' : 'this'} inbox is empty
            </h1>
            {isOwner ? '' : <text>ask {profileName} a new q</text>}
          </div>
          <div
            class={'footer'}
            style={{
              ...squareErrorFooterStyles
            }}
          >
            <div
              style={{
                ...footerTextStyles,
                fontSize: '2em'
              }}
            >
              <text>qbase</text>
              <text
                style={{
                  ...qbaseVersionStyles
                }}
              >{qbaseVersion}</text>
              <img
                height='100px'
                width='100px'
                src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
              />
            </div>
          </div>
        </div>
      ),
      imageOptions: { width: 1200, height: 1200 },
      imageAspectRatio: '1:1',
      intents: [
        <Button.Reset>back</Button.Reset>,
      ]
    })
  }

  // else
  const state = deriveState(previousState => {
    let newState: State = previousState as State
    if (buttonValue == 'back') {
      newState.currentQ++
    } else if (buttonValue == 'forward') {
      newState.currentQ--
    } else if (newState.currentQ < 0) {
      newState.currentQ = qCount - 1
    }
  })
  // console.log('state', state)
  // console.log('currentQ', state.currentQ)
  // console.log('receivedQs', receivedQs)
  const finalQ = state.currentQ == 0
  // console.log('qCount', qCount)
  // console.log('count', statefulState.qCount)
  // console.log('finalQ', finalQ)

  //// get Q and count from bagelDB ////
  const qid = Number(receivedQs[state.currentQ].q_id)
  const qResponse: GetQResponse = await getQById(qid, c.env, false)
  const qMetadata = qResponse.metadatas && qResponse.metadatas[0]
  if (!qMetadata) {
    console.log('id', qResponse.documents && qResponse.documents[0])
    throw new Error('trouble reaching DB')
  }
  const {
    coiner_name,
    coiner_fid,
  } = qMetadata as Q
  const q = qMetadata?.['bagel:document'] as string


  //// build intents ////
  let intents = []
  const urlMain = `https://qbase.tech/q/${qid}/img.png` // change this from 'q' to 'a/r'
  const linkUrl = `https://warpcast.com/~/compose?embeds[]=${urlMain}`

  if (state.currentQ < qCount - 1) intents.push(
    <Button action={`/${profileName}/qs`} value='back'>←</Button>)
  if (!finalQ) intents.push(<Button action={`/${profileName}/qs`} value='forward'>→</Button>)
  intents.push(<Button.Reset>back</Button.Reset>)
  if (isOwner) intents.push(<Button.Link href={linkUrl}>answer</Button.Link>)

  const qFontSize: string = q.length < 30
    ? '6em'
    : q.length < 120
      ? '5em'
      : '4em'

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
            ...qContainerStyles,
            paddingTop: '60px'
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
              coined by {coiner_name}
              <span style={{ fontSize: '.5em', marginLeft: '6px' }}>({coiner_fid})</span>
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
            <text>{Date.now()}</text>
          </div>
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 1200 },
    imageAspectRatio: '1:1',
    intents: intents
  })
}

