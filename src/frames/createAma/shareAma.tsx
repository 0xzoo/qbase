import {
  Button,
  FrameHandler,
} from 'frog'
import {
  amaBackgroundStyles,
  amaHomeStyles,
  amaTextStyles,
  avatarStyles,
  backgroundStyles,
  footerStyles,
} from '../../styles'
import {
  CustomFrameContext,
} from '.'
import {
  getProfileDataFromFid
} from '../../api/airstack/hub'
import { colors } from '../../styles'
// import logo from '/icon.png'

export const shareAmaFrame: FrameHandler = async (c: CustomFrameContext) => {
  const { frameData } = c
  const fid = frameData?.fid as number
  const { profileData, error } = await getProfileDataFromFid(fid)
  if (error) console.log('amaHomeError', error)
  const { profileName, image } = profileData

  // TODO! if (error) return c.res(errorScreen("Sorry we couldn't find that user. Please check your spelling is correct in the url"))
  const urlMain = `https://qbase.tech/ama/${profileName}`
  const linkUrl = `https://warpcast.com/~/compose?embeds[]=${urlMain}`

  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...amaBackgroundStyles
        }}
      >
        <div
          style={{
            ...amaHomeStyles
          }}
        >
          <img
            style={{ ...avatarStyles }}
            src={image}
          />
          <div
            style={{
              ...amaTextStyles
            }}
          >
            <text style={{ margin: 0, padding: 0 }}>ask</text>
            <text style={{ margin: 0, padding: 0, color: colors.purpler }}>{profileName}</text>
            <text style={{ margin: 0, padding: 0 }}>anything</text>
          </div>
        </div>
        <div
          class={'footer'}
          style={{
            ...footerStyles
          }}
        >
          <text>buitl on qbase</text>
          <img
            height='60px'
            width='60px'
            style={{
              marginRight: '5px',
            }}
            src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
          />
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 630 },
    intents: [
      <Button.Link href={linkUrl}>ask</Button.Link>
    ]
  })
}