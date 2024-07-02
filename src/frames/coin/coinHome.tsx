import {
  Button,
  TextInput,
  FrameHandler,
} from 'frog'
import {
  backgroundStyles,
  homeStyles,
} from '../../styles'
import { CustomFrameContext } from '.'
// import logo from '/icon.png'


export const coinHomeScreen: FrameHandler = async (c: CustomFrameContext) => {
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
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%'
          }}
        >
          <img
            width={'300px'}
            height={'300px'}
            src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
          />
          <div
            style={{
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              fontSize: '42px',
              color: '#fff',
              marginTop: '60px'
            }}
          >
            <text style={{ margin: 0, padding: 0 }}>coin a q</text>
            <text style={{ margin: 0, padding: 0 }}>build the base</text>
            <text style={{ margin: 0, padding: 0 }}>phase 2 coming soon<span style={{ fontSize: '16px' }}>TM</span></text>
          </div>
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 630 },
    intents: [
      <TextInput placeholder="?" />,
      <Button action="/check">query</Button>,
      <Button action='/coinedQs'>see qs</Button>,
    ]
  })
}