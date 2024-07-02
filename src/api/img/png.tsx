import { ImageResponse } from "hono-og"
import { GetQResponse, Q } from "../db/types"
import { getQById } from "../db/bagel"
import { Env } from "../.."
import {
  backgroundStyles,
  coinerStyles,
  qStyles,
  screenStyles,
  shareableQContainerStyles,
  shareableQDataContainerStyles,
  shareableQDataStyles
} from "../../styles"
import { getFont } from "../../fonts"


export async function getShareableQPng(qid: string, env: Env) {
  const idNumber = Number(qid)
  const qResponse: GetQResponse = await getQById(idNumber, env)
  const qMetadata = qResponse.metadatas && qResponse.metadatas[0]
  if (!qMetadata) throw new Error('trouble reaching DB')
  const {
    coiner_name,
    coiner_fid,
  } = qMetadata as Q
  const q = qMetadata?.['bagel:document'] as string

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
            ...shareableQContainerStyles
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
            ...shareableQDataContainerStyles,
            marginLeft: '60px',
          }}
        >
          <div
            style={{
              ...shareableQDataStyles
            }}
          >
            <text>coined by</text>
            <text
              style={{
                ...coinerStyles
              }}
            >
              {coiner_name}
              {coiner_fid == '272012' ? '' : <span style={{ fontSize: '8px', marginLeft: '6px' }}>({coiner_fid})</span>}
            </text>
          </div>
          <img
            height='80px'
            width='80px'
            src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
          />
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [helvetica, helveticaBold]
    },
  )
}

// app.get('/posts/:filename{.+.png$}', (c) => {