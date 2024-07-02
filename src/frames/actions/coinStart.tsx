import {
  Button,
  FrameHandler,
} from 'frog'
import {
  actionsHomeStyles,
  actionsTextStyles,
  backgroundStyles
} from '../../styles'
import { CustomFrameContext } from '.'

const tipValue = 1

const coinStartScreen: FrameHandler = async (c: CustomFrameContext) => {
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
          <h1 style={{ marginBottom: '20px', padding: 0 }}>coin and coin-flip</h1>
          <text style={{ marginBottom: '15px', padding: 0 }}>
            <span style={{ fontWeight: 600, marginRight: '10px' }}>coin</span> a new question, or <span style={{ fontWeight: 600, marginLeft: '10px', marginRight: '10px' }}>coin-flip</span> one from the feed...
          </text>
          <text style={{ margin: 0, padding: 0, lineHeight: '1.2em' }}>
            when you coin-flip, if the q has already been coined, you'll tip the owner {tipValue} $qp 🫰
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
    // imageOptions: { width: 1200, height: 630 },
    intents: [
      <Button action='/coin/new'>coin new q</Button>,
      <Button action='/coin/flip'>coin-flip</Button>,
      <Button.Reset>back</Button.Reset>
    ]
  })
}

export default coinStartScreen