import {
  Button,
  FrameHandler
} from 'frog'
import { CustomFrameContext } from './index.js'
import {
  backgroundStyles,
  coinerStyles,
  // colors,
  headerStyles,
  headerTextDataStyles,
  headerTextStyles,
  qContainerStyles,
  qDataStyles,
  qStyles,
  screenStyles,
  similarQsStyles
} from '../../styles.js'
import {
  queryForSimilar
} from '../../api/db/bagel.js'
import { Q, QQueryResponse } from '../../api/db/types.js'
import { State } from './index'
import { getOrCreateUser } from '../../api/db/d1.js'
import { qbaseVersion } from '../../api/db/bagel.js'


const coinCheckScreen: FrameHandler = async (c: CustomFrameContext) => {
  //// frame data ////
  const { inputText, frameData, deriveState } = c

  const qfid = frameData?.fid as number
  // log q to state
  deriveState(previousState => {
    let newState: State = previousState as State
    newState.q = inputText as string
  })
  // truncate text, or respond that text is too long. max input same as cast?
  let truncatedText = inputText?.length && inputText?.length > 325
    ? inputText.substring(0, 322) + '...'
    : inputText

  //// userDB ////
  let asker = await getOrCreateUser(qfid, c.env.DB)


  //// uniqueness ////
  // search bagelDB for q
  const qSimilars: QQueryResponse = await queryForSimilar(inputText as string, c.env)
  const nearestSimilar = qSimilars.distances && qSimilars.distances[0][0] as number
  const nearestSimilarMetadata = (qSimilars.metadatas && qSimilars.metadatas[0][0]) as unknown as Q
  // console.log('qSimilars', qSimilars)

  // check for previous qs
  type coinedStatus = 'yes' | 'no' | 'maybe'
  let alreadyCoined: coinedStatus
  if (nearestSimilar == null) {
    console.log('error retrieving from bagel')
    alreadyCoined = 'no'
  }
  else if (nearestSimilar > .99) {
    alreadyCoined = 'yes'
  } else if (nearestSimilar > .7) {
    alreadyCoined = 'maybe'
  } else {
    alreadyCoined = 'no'
  }

  const uniqueness = () => {
    let unique
    if (alreadyCoined == 'yes') {
      unique = <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          alignItems: 'flex-start'
        }}
      >
        <text
          style={{
            ...coinerStyles
          }}
        >
          coined by {nearestSimilarMetadata.coiner_name}
          <span style={{ fontSize: '1em', marginLeft: '6px' }}>({nearestSimilarMetadata.coiner_fid})</span>
        </text>
      </div>
      // if similar qs, add intent to 
    } else if (alreadyCoined == 'maybe') {
      unique = <div
        style={{
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <text>similar qs:</text>
        {qSimilars.documents && qSimilars.documents[0].map((doc) => {
          let truncatedQ = doc.length > 58
            ? doc.substring(0, 54) + '...'
            : doc
          return (
            <text>{truncatedQ}</text>
          )
        })}
      </div>
    } else {
      unique = <text>this q is new</text>
    }

    return (
      <div
        class={'data'}
        style={{
          ...similarQsStyles
        }}
      >
        {unique}
      </div>
    )
  }

  const urlMain = `https://qbase.crypt0z00.workers.dev/q/${nearestSimilarMetadata.id}/img.png`
  const linkUrl = `https://warpcast.com/~/compose?embeds[]=${urlMain}`

  //// conditional intents ////
  const intents = alreadyCoined == 'yes'
    ? [
      <Button.Reset>back</Button.Reset>,
      <Button action='/coin/new'>edit</Button>,
      <Button.Link href={linkUrl}>share</Button.Link>
    ]
    : alreadyCoined == 'maybe'
      ? [
        <Button.Reset>back</Button.Reset>,
        <Button action='/coin/new'>edit</Button>,
        <Button action="/coin/finish">coin</Button>
        // <Button.Link href={linkUrl}>share</Button.Link>
        // <Button action='/coinedQs' value=''></Button>
      ]
      : [
        <Button.Reset>back</Button.Reset>,
        <Button action='/coin/new'>edit</Button>,
        <Button action="/coin/finish">coin</Button>,
        // <Button.Link href={linkUrl}>share</Button.Link>
      ]

  // const profileName = statefulState.anon == false
  //   ? data?.profileName ?? ''
  //   : '4n0n'
  // const profileColor = statefulState.anon == false
  //   ? colors.fcPurple
  //   : colors.anonRed

  // let buttonIntents = [
  //   <Button action=":fid/qSuccess" value={buttonValue}>Submit</Button>,
  //   <Button.Reset>Edit</Button.Reset>
  // ]

  // const seeAnswers = <Button action="/ama/" value="private">See Answers</Button>
  // // if (alreadyAnswered == 'yes') buttonIntents.push(seeAnswers) + remove submit
  const qFontSize: string = truncatedText
    ? truncatedText.length < 30
      ? '6em'
      : truncatedText.length < 120
        ? '5em'
        : '4em'
    : ''

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
            {truncatedText}
          </h1>
        </div>
        <div
          class={'dataContainer'}
          style={{
            ...qDataStyles,
          }}
        >
          {uniqueness()}
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
              ...headerTextStyles,
              fontSize: '2em'
            }}
          >
            <text style={{ marginBottom: '10px' }}>
              your points: {asker.points_balance || '0'}
            </text>
          </div>
          <div
            style={{
              ...headerTextStyles,
              fontSize: '2em',
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
    intents: intents
  })
}

export default coinCheckScreen