import {
  Button,
  TextInput,
  FrameHandler,
} from 'frog'
import {
  actionsHomeStyles,
  actionsTextStyles,
  backgroundStyles,
} from '../../styles'
import { CustomFrameContext } from '.'
// import logo from '/icon.png'


const coinNewScreen: FrameHandler = async (c: CustomFrameContext) => {
  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...actionsHomeStyles
        }}
      >
        <div
          class={'text'}
          style={{
            ...actionsTextStyles
          }}
        >
          <h1 style={{ marginBottom: '20px', padding: 0 }}>coin a new q</h1>
          <text style={{ marginBottom: '15px', padding: 0 }}>
            first, let's check if someone has asked it before...
          </text>
        </div>
        <div
          class={'footer'}
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'flex-end',
            alignItems: 'center',
            width: '100%',
            marginTop: '30px',
            marginBottom: '10px'
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
      <Button.Reset>back</Button.Reset>,
      <Button action='/seeQs'>see qs</Button>,
      <Button action="/coin/check">check</Button>,
    ]
  })
}

export default coinNewScreen