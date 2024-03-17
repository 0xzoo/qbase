import { AutoTokenizer } from '@xenova/transformers';
import {
  Button,
  FrameContext,
  FrameHandler
} from 'frog'
import {
  init,
  getFarcasterUserDetails,
  FarcasterUserDetailsInput,
  FarcasterUserDetailsOutput,
} from '@airstack/frames'
import {
  backgroundStyles,
  qSuccessStyles,
  qContainerStyles,
  qStyles,
  askedByStyles,
  ownerStyles,
  qFooterStyles,
  colors
} from '../../styles.js'

const model = 'Xenova/claude-tokenizer' //'Xenova/bert-base-uncased'
const tokenizer = await AutoTokenizer.from_pretrained(model);

export const askScreen: FrameHandler = async (c: FrameContext) => {
  init(process.env.AIRSTACK_API_KEY || "")
  const { inputText, buttonValue, frameData, verified } = c
  console.log('verified?:', verified)
  const qfid = frameData?.fid as number
  const anon = buttonValue == "public"
    ? false
    : true

  // tokenize q
  const tokens = tokenizer.encode(inputText as string)
  console.log(tokens)

  // // lsh hash q

  // check for previous answers

  // get farcaster user details for sender
  const input: FarcasterUserDetailsInput = {
    fid: qfid
  }
  const { data, error }: FarcasterUserDetailsOutput = await getFarcasterUserDetails(input);
  if (error) throw new Error(error)

  // get sender balance

  // set conditional vars
  const profileName = anon == false
    ? data?.profileName ?? ''
    : '4n0n'
  const profileColor = anon == false
    ? colors.fcPurple
    : colors.anonRed
  let buttonIntents = [
    <Button action="/ama/:fid/qSuccess" value={buttonValue}>Submit</Button>,
    <Button.Reset>Edit</Button.Reset>
  ]

  // const seeAnswers = <Button action="/ama/" value="private">Edit</Button>
  // // if alreadyAnswered buttonIntents.splice(1,0, seeAnswers) 

  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...qSuccessStyles
        }}
      >
        <div
          style={{
            ...qContainerStyles
          }}
        >
          <h1 style={{ ...qStyles }}>{inputText}</h1>
        </div>
        <div style={{ ...qFooterStyles }}>
          <div
            style={{ ...askedByStyles }}
          >
            - <span style={{ ...ownerStyles, color: profileColor }}>{profileName}</span>
          </div>
          {/* <img
            style={{ ...logoStyles }}
            src={}
          /> */}
        </div>
      </div>
    ),
    intents: buttonIntents
  })
}