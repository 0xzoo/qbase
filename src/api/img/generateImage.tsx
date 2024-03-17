import satori from 'satori'
import {
  backgroundStyles,
  qSuccessStyles,
  qContainerStyles,
  qStyles,
  askedByStyles,
  ownerStyles
} from '../../styles.js'
import { getFont } from '../../fonts.js'

const helvetica = await getFont(400)
const helveticaBlack = await getFont(600)

export async function generateImage(sender: string, stem: string) {
  const imageSvg = await satori(
    <div
      style={{
        ...backgroundStyles,
        ...qSuccessStyles
      }}
    >
      <div
        style={{
          ...qContainerStyles
        }}
      >
        <h1 style={{ ...qStyles }}>{stem}</h1>
      </div>
      <div
        style={{ ...askedByStyles }}
      >
        asked by <span style={{ ...ownerStyles }}>{sender}</span>
      </div>
    </div>,
    {
      width: 1200,
      height: 1200,
      fonts: [helvetica, helveticaBlack],
    }
  )

  return imageSvg
}