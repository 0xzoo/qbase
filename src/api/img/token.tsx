import { ImageResponse } from "hono-og"
// import { GetQResponse, Q } from "../db/types"
// import { getQById } from "../db/bagel"
// import { Env } from "../.."
import {
  backgroundStyles,
  // qDataStyles,
  // coinerStyles,
  qStyles,
  screenStyles,
  // shareableQContainerStyles,
  // shareableQDataContainerStyles,
  // shareableQDataStyles,
  similarQsStyles
} from "../../styles"
import { getFont } from "../../fonts"


export async function getTokenPng(q: string) {

  const helvetica = await getFont(400)
  const helveticaBold = await getFont(500)

  const qFontSize: string = q.length < 45
    ? '6em'
    : q.length < 100
      ? '5em'
      : q.length < 200
        ? '4em'
        : '3em'

  return new ImageResponse(
    (
      <div
        style={{
          ...backgroundStyles,
          ...screenStyles
        }}
      >
        <div
          class={'qContainer'}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '930px',
            paddingTop: '200px',
            paddingRight: '60px',
            paddingLeft: '60px',
            backgroundImage: 'linear-gradient(135deg, rgb(0, 124, 240), rgb(0, 223, 216))',
            backgroundClip: 'text',
            '-webkit-background-clip': 'text',
            color: 'transparent'
          }}
        >
          <h1
            class={'q'}
            style={{
              ...qStyles,
              fontSize: qFontSize
            }}
          >
            {q}
          </h1>
        </div>
        <div
          class={'dataContainer'}
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginRight: '30px',
            marginLeft: '30px',
            height: '140px',
          }}
        >
          <div
            class={'data'}
            style={{
              ...similarQsStyles,
            }}
          >
            {/* <text
              style={{
                ...coinerStyles
              }}
            >
              coined by {profileName}
              <span style={{ fontSize: '.5em', marginLeft: '6px' }}>({qfid})</span>
            </text> */}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              height: '100%'
            }}
          >
            <img
              height='100px'
              width='100px'
              src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
            />
            <text>v0.1.0</text>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 1200,
      fonts: [helvetica, helveticaBold]
    },
  )
}