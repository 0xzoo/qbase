import {
  Button,
  TextInput,
  FrameHandler,
} from 'frog'
import {
  amaBackgroundStyles,
  amaHomeStyles,
  amaTextStyles,
  avatarStyles,
  backgroundStyles,
  footerStyles,
  nglGradienttStyles,
  // screenStyles,
} from '../../styles'
import {
  CustomFrameContext,
  // State
} from '.'
import { getProfileDataFromName } from '../../api/airstack/hub'
// import { colors } from '../../styles'
// import logo from '/icon.png'

type param = {
  profileName: string
}

export const amaHomeScreen: FrameHandler = async (c: CustomFrameContext) => {
  // const { deriveState } = c
  const { profileName } = c.req.param() as unknown as param
  const { profileData, error } = await getProfileDataFromName(profileName)
  // console.log('profileName', profileName)
  // console.log('profileData', profileData)
  // TODO! if (error) return c.res(errorScreen("Sorry we couldn't find that user. Please check your spelling is correct in the url"))
  if (error) console.log('amaHomeError', error)
  const {
    // fid,
    image
  } = profileData
  // deriveState(previousState => {
  //   let newState: State = previousState as State
  //   newState.fid = fid
  // })
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
            <text style={{ margin: 0, padding: 0, ...nglGradienttStyles }}>{profileName}</text>
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
      <TextInput placeholder="?" />,
      <Button action={`/${profileName}/confirm`} value='id'>ask</Button>,
      <Button action={`/${profileName}/confirm`} value='anon'>ask anon</Button>,
      <Button action={`/${profileName}/qs`}>see qs</Button>
    ]
  })
}