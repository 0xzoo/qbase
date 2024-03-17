import {
  Button,
  TextInput,
  FrameHandler,
  FrameContext
} from 'frog'
import {
  init,
  getFarcasterUserDetails,
  FarcasterUserDetailsInput,
  FarcasterUserDetailsOutput,
} from '@airstack/frames'
import {
  backgroundStyles,
  homeStyles,
  avatarStyles,
  amaStyles
} from '../../styles.js'


export const homeScreen: FrameHandler = async (c: FrameContext) => {
  init(process.env.AIRSTACK_API_KEY || "")
  const fid = c.req.param('fid' as never) as number
  const input: FarcasterUserDetailsInput = {
    fid: fid
  }

  const { data, error }: FarcasterUserDetailsOutput = await getFarcasterUserDetails(input);
  if (error) throw new Error(error)
  const profileName = data?.profileName ?? ''
  const profileImage = data?.profileImage?.medium ?? ''

  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...homeStyles
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%'
          }}
        >
          <img
            style={{ ...avatarStyles }}
            src={profileImage ?? ""}
          />
          <div
            style={{ ...amaStyles }}
          >
            <p style={{ margin: 0, padding: 0 }}>ask</p>
            <p style={{ margin: 0, padding: 0 }}>{profileName}</p>
            <p style={{ margin: 0, padding: 0 }}>anything</p>
          </div>
        </div>
      </div>
    ),
    intents: [
      <TextInput placeholder="?" />,
      <Button action="/ama/:fid/ask" value="public">Ask</Button>,
      <Button action="/ama/:fid/ask" value="private">Ask Anon</Button>,
      <Button action="/ama/:fid/qs">See Qs</Button>,
    ]
  })
}