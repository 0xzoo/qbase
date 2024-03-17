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
import { AIRSTACK_API_KEY } from './index.js'

export const qSuccess: FrameHandler = async (c: FrameContext) => {
  init(process.env.AIRSTACK_API_KEY || AIRSTACK_API_KEY)
  const { inputText, buttonValue, frameData } = c
  const qfid = frameData?.fid as number
  const input: FarcasterUserDetailsInput = {
    fid: qfid
  }

  const { data, error }: FarcasterUserDetailsOutput = await getFarcasterUserDetails(input);
  if (error) throw new Error(error)

  const profileName = buttonValue == 'public'
    ? data?.profileName ?? ''
    : '4n0n'

  const profileColor = buttonValue == 'public'
    ? colors.fcPurple
    : colors.anonRed

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
            asked by <span style={{ ...ownerStyles, color: profileColor }}>{profileName}</span>
          </div>
          {/* <img
            style={{ ...logoStyles }}
            src={}
          /> */}
        </div>
      </div>
    ),
    intents: [
      <Button action="/aqz" value="public" >Check Mint</Button>,
      <Button action="/aqz" value="private">Edit</Button>,
    ]
  })
}