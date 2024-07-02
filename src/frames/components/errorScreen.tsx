/** @jsxImportSource frog/jsx */

import {
  backgroundStyles,
  errorSecondaryTextStyles,
  errorTextContainerStyles,
  errorTextStyles,
  footerTextStyles,
  qbaseVersionStyles,
  screenStyles,
  squareErrorFooterStyles
} from "../../styles"
import { qbaseVersion } from "../../api/db/bagel"


export function errorScreen(
  errorText: string,
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
        class={'errorTextContainer'}
        style={{
          ...errorTextContainerStyles,
          ...(square ? { paddingTop: '200px' } : { paddingTop: '80px' })
        }}
      >
        <h1
          class={'errorText'}
          style={{
            ...errorTextStyles,
            fontSize: '90px'
          }}
        >
          {errorText}
        </h1>
        {secondaryText && (
          <text
            style={{
              ...errorSecondaryTextStyles,
              fontSize: '50px'
            }}
          >{secondaryText}</text>
        )}
      </div>
      <div
        class={'footer'}
        style={{
          ...squareErrorFooterStyles
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