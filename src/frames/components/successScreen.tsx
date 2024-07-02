/** @jsxImportSource frog/jsx */

import {
  backgroundStyles,
  successTextContainerStyles,
  successTextStyles,
  footerTextStyles,
  qbaseVersionStyles,
  screenStyles,
  squareSuccessFooterStyles
} from "../../styles"
import { qbaseVersion } from "../../api/db/bagel"


export function successScreen(
  successText: string,
  secondaryText?: string,
  square?: boolean
) {
  return (
    <div
      style={{
        ...backgroundStyles,
        ...screenStyles
      }}
    >
      <div
        class={'successTextContainer'}
        style={{
          ...successTextContainerStyles,
          ...(square ? { paddingTop: '200px' } : { paddingTop: '80px' })
        }}
      >
        <h1
          class={'successText'}
          style={{
            ...successTextStyles,
            fontSize: '90px'
          }}
        >
          {successText}
        </h1>
        {secondaryText && (
          <text>{secondaryText}</text>
        )}
      </div>
      <div
        class={'footer'}
        style={{
          ...squareSuccessFooterStyles
        }}
      >
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