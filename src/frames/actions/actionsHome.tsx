import {
  Button,
  FrameHandler
} from 'frog'
import {
  actionsHomeStyles,
  actionsTextStyles,
  backgroundStyles
} from '../../styles'
import { CustomFrameContext } from '.'

const actionsHomeScreen: FrameHandler = async (c: CustomFrameContext) => {
  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...actionsHomeStyles
        }}
      >
        <div
          class={'logos'}
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            height: '400px',
            marginRight: '30px'
          }}
        >
          <div
            style={{
              width: '400px',
              height: '400px',
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <img
              height='375px'
              width='375px'
              src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
            />
          </div>
          <h1 style={{
            ...actionsTextStyles,
            fontSize: '200px',
            marginLeft: '20px',
            marginRight: '60px'
          }}>x</h1>
          <div
            style={{
              width: '400px',
              height: '400px',
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <img
              height='330px'
              width='330px'
              style={{
              }}
              src={'https://github.com/vrypan/farcaster-brand/raw/main/icons/icon-rounded/purple-white.png'}
            />
          </div>
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 630 },
    intents: [
      <Button action="/coin">coin q</Button>,
      <Button action="/mint/start">mint q</Button>,
      // <Button action='/admin'>admin</Button>,
      <Button action='/answer'>log answer</Button>
    ]
  })
}

export default actionsHomeScreen