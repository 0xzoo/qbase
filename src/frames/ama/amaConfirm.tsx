import {
  Button,
  FrameHandler
} from 'frog'
import { CustomFrameContext } from './index.js'
import {
  backgroundStyles,
  coinerStyles,
  footerDataStyles,
  footerTextStyles,
  footerWDataStyles,
  // colors,
  pointsLabelStyles,
  pointsRowStyles,
  pointsStyles,
  pointsValueStyles,
  qContainerStyles,
  qDataStyles,
  qStyles,
  qbaseVersionStyles,
  screenStyles,
  similarQsStyles
} from '../../styles.js'
import {
  // getQByDoc,
  queryForSimilar
} from '../../api/db/bagel.js'
import { Q, QQueryResponse } from '../../api/db/types.js'
import { State } from './index'
import { getOrCreateUser, getReceivedDirectQs } from '../../api/db/d1.js'
import { qbaseVersion } from '../../api/db/bagel.js'
import { getProfileDataFromName } from '../../api/airstack/hub.js'

type param = {
  profileName: string
}

export const amaConfirmScreen: FrameHandler = async (c: CustomFrameContext) => {
  //// frame data ////
  const {
    inputText,
    frameData,
    buttonValue,
    deriveState,
  } = c
  const { profileName } = c.req.param() as unknown as param
  console.log('a')
  const { profileData, error } = await getProfileDataFromName(profileName)
  console.log('b')
  if (error) console.log('amaHomeError', error)
  const {
    fid,
  } = profileData
  const qfid = frameData?.fid as number
  // truncate text, or respond that text is too long. max input same as cast?
  let truncatedText = inputText?.length && inputText?.length > 325
    ? inputText.substring(0, 322) + '...'
    : inputText

  //// userDB ////
  let asker = await getOrCreateUser(qfid, c.env.DB)
  let recipient = await getOrCreateUser(fid, c.env.DB)

  //// uniqueness ////
  // search bagelDB for q, then use similars to search postgres for userQs to same recipient
  const qSimilars: QQueryResponse = await queryForSimilar(inputText as string, c.env)
  const nearestSimilarDistance = qSimilars.distances && qSimilars.distances[0][0] as number
  const nearestSimilarQ = (qSimilars.metadatas && qSimilars.metadatas[0][0]) as unknown as Q

  // check for previous qs
  type coinedStatus = 'yes' | 'no' | 'maybe'
  let alreadyCoined: coinedStatus
  if (nearestSimilarDistance == null) {
    throw Error('trouble reaching DB. please try again')
  }
  else if (nearestSimilarDistance > .99) {
    alreadyCoined = 'yes'
  } else if (nearestSimilarDistance > .7) {
    alreadyCoined = 'maybe'
  } else {
    alreadyCoined = 'no'
  }

  // log vars to state
  deriveState(previousState => {
    let newState: State = previousState as State
    newState.q = inputText as string
    newState.id = recipient.id
    newState.fid = recipient.fid as number
    if (buttonValue == 'anon') newState.anon = true
    if (alreadyCoined == 'yes') newState.qid = nearestSimilarQ.id
  })

  let unique
  let alreadyAsked: boolean = false
  // let similarReceivedQs: string[] = []

  // if not coined, not asked
  if (alreadyCoined == 'yes') {
    //   // unique = <text>this q is new</text> // necessary here?
    // } else {
    const receivedQs = await getReceivedDirectQs(recipient.id, c.env.DB)
    // let alreadyReceivedQ
    for (let j = 0; j < receivedQs.length; j++) {
      const receivedQ = receivedQs[j]
      // if q already asked, push to similarReceivedQs, set alreadyAsked to true
      if (receivedQ.q_id == nearestSimilarQ.id) {
        alreadyAsked = true
        // alreadyReceivedQ = receivedQ
      }
      // but what if its just similar?
    }

    if (alreadyAsked) {
      unique = <div
        style={{ display: 'flex' }}
      >
        <text>someone already asked {recipient.fname} this q</text>
      </div>
      // unique = <div
      //   style={{
      //     display: 'flex',
      //     flexDirection: 'column',
      //     justifyContent: 'flex-start',
      //     alignItems: 'flex-start'
      //   }}
      // >
      //   <text
      //     style={{
      //       ...coinerStyles
      //     }}
      //   >
      //     asked by {nearestSimilarQ.coiner_name}
      //     <span style={{ fontSize: '1em', marginLeft: '6px' }}>({alreadyReceivedQ.coiner_fid})</span>
      //   </text>
      // </div>
      // } else if (!alreadyAsked && similarReceivedQs.length) {
      //   unique = <div
      //     style={{
      //       display: 'flex',
      //       flexDirection: 'column'
      //     }}
      //   >
      //     <text>already asked:</text>
      //     {similarReceivedQs.map((doc) => {
      //       let truncatedQ = doc.length > 58
      //         ? doc.substring(0, 54) + '...'
      //         : doc
      //       return (
      //         <text>{truncatedQ}</text>
      //       )
      //     })}
      //   </div>
    } else {
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
          coined by {nearestSimilarQ.coiner_name}
          {nearestSimilarQ.coiner_fid == '272012'
            ? ''
            : <span
              style={{
                fontSize: '1em',
                marginLeft: '6px'
              }}
            >
              ({nearestSimilarQ.coiner_fid})
            </span>
          }
        </text>
      </div>
    }
  }


  //// conditional intents ////
  const intents = alreadyAsked
    ? [
      <Button.Reset>edit</Button.Reset>,
      <Button action='/:profileName/qs'>see qs</Button>
    ]
    // : !alreadyAsked && similarReceivedQs.length
    //   ? [
    //     <Button.Reset>edit</Button.Reset>,
    //     <Button action="/:profileName/success">submit</Button>,
    //     <Button action='/:profileName/qs'>see qs</Button>
    //   ]
    : [
      <Button.Reset>edit</Button.Reset>,
      <Button action={`/${profileName}/success`}>submit</Button>,
      <Button action={`/${profileName}/qs`}>see qs</Button>,
    ]


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
          <div
            class={'data'}
            style={{
              ...similarQsStyles
            }}
          >
            {unique}
          </div>
        </div>
        <div
          class={'footer'}
          style={{
            ...footerWDataStyles
          }}
        >
          <div
            class={'footerData'}
            style={{
              ...footerDataStyles
            }}
          >
            <div
              class={'pointsLabels'}
              style={{
                ...pointsStyles,
                ...pointsLabelStyles,
                fontSize: '2em'
              }}
            >
              <text style={{ ...pointsRowStyles }}>
                points balance:
              </text>
              {/* <text style={{ ...pointsRowStyles }}>
              points allowance:
            </text> */}
              <text>cost:</text>
            </div>
            <div
              class={'pointsValues'}
              style={{
                ...pointsStyles,
                ...pointsValueStyles,
                fontSize: '2em'
              }}
            >
              <text style={{ ...pointsRowStyles }}>
                {asker.points_balance || '0'}
              </text>
              {/* <text style={{ ...pointsRowStyles }}>
              24
            </text> */}
              <text style={{ ...pointsRowStyles }}>
                4
              </text>
            </div>
          </div>
          <div
            class={'qbase'}
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
    intents: intents
  })
}