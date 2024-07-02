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

const addActionScreen: FrameHandler = async (c: CustomFrameContext) => {
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
          <h1 style={{ marginBottom: '20px', padding: 0 }}>add qbase</h1>
          <text style={{ margin: 0, padding: 0 }}>
            coin and mint questions or prompts directly from the feed,or save your answers and responses to your data backpack.
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
      <Button.AddCastAction
        action='/actions'
      >
        add qbase
      </Button.AddCastAction>
    ]
  })
}

export default addActionScreen