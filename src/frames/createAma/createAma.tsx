import {
  Button,
  FrameHandler,
} from 'frog'
import {
  actionsHomeStyles,
  backgroundStyles,
  createAmaStyles,
  nglGradienttStyles
} from '../../styles'
import { CustomFrameContext } from '.'


export const createAmaFrame: FrameHandler = async (c: CustomFrameContext) => {
  return c.res({
    image: (
      <div
        style={{
          ...backgroundStyles,
          ...actionsHomeStyles
        }}
      >
        <img
          height='450px'
          width='450px'
          style={{
            marginTop: '90px',
            marginLeft: '600px',
          }}
          src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
        />
        <div
          class={'text'}
          style={{
            ...createAmaStyles
          }}
        >
          <text>\\ ask</text>
          <text>\\ anything</text>
          <text style={{ ...nglGradienttStyles }}>\\ anon</text>
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
            marginBottom: '10px',
            marginRight: '30px',
          }}
        >
          <text>buitl on qbase</text>
        </div>
      </div>
    ),
    imageOptions: { width: 1200, height: 630 },
    // imageAspectRatio: '1:1',
    intents: [
      <Button action='/share'>create my ama</Button>
    ]
  })
}