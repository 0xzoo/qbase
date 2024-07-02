/** @jsxImportSource frog/jsx */

import {
  backgroundStyles,
  footerStyles,
  footerTextStyles,
  pointsLabelStyles,
  pointsRowStyles,
  pointsStyles,
  pointsValueStyles,
  qContainerStyles,
  qDataStyles,
  qStyles,
  qbaseVersionStyles,
  screenStyles,
  similarQsStyles
} from "../../styles"


export const confirmScreen = (
  qFontSize: string,
  truncatedText: string,
  unique: any,
  qbaseVersion: string,
  asker: any
) => {
  return (
    <div
      style={{
        ...backgroundStyles,
        ...screenStyles
      }}
    >
      <div
        class={'qContainer'}
        style={{
          ...qContainerStyles
        }}
      >
        <h1
          class={'q'}
          style={{
            ...qStyles,
            fontSize: qFontSize
          }}
        >
          {truncatedText}
        </h1>
      </div>
      <div
        class={'dataContainer'}
        style={{
          ...qDataStyles,
        }}
      >
        <div
          class={'data'}
          style={{
            ...similarQsStyles
          }}
        >
          {unique}
        </div>
      </div>
      <div
        class={'footer'}
        style={{
          ...footerStyles
        }}
      >
        <div>
          <div
            style={{
              ...pointsStyles,
              ...pointsLabelStyles,
              fontSize: '2em'
            }}
          >
            <text style={{ ...pointsRowStyles }}>
              points balance:
            </text>
            <text style={{ ...pointsRowStyles }}>
              points allowance:
            </text>
            <text>cost:</text>
          </div>
          <div
            style={{
              ...pointsStyles,
              ...pointsValueStyles,
              fontSize: '2em'
            }}
          >
            <text style={{ ...pointsRowStyles }}>
              {asker.points_balance || '0'}
            </text>
            <text style={{ ...pointsRowStyles }}>
              24
            </text>
            <text style={{ ...pointsRowStyles }}>
              4
            </text>
          </div>
        </div>
        <div
          style={{
            ...footerTextStyles,
            fontSize: '2em'
          }}
        >
          <text>qbase</text>
          <text
            style={{
              ...qbaseVersionStyles
            }}
          >{qbaseVersion}</text>
          <img
            height='100px'
            width='100px'
            src={'https://github.com/0xzoo/qbase/raw/623f56f617fc4c8a5b9d68d730bcac7a71a1fc77/public/icon.png'}
          />
        </div>
      </div>
    </div>
  )
}  
