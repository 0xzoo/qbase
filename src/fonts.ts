declare type Weight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
declare type Style = 'normal' | 'italic'

export interface FontOptions {
  data: Buffer | ArrayBuffer
  name: string
  weight?: Weight
  style?: Style
  lang?: string
}

const baseUrl = 'https://github.com/0xzoo/qbase/raw/main/assets/fonts'

export async function getFont(weight: Weight) {
  let fontData: ArrayBuffer

  if (weight == 400) {
    fontData = await fetchFont(`${baseUrl}/Helvetica.otf`)
  } else if (weight == 500) {
    fontData = await fetchFont(`${baseUrl}/Helvetica-Bold.otf`)
  } else if (weight == 600) {
    fontData = await fetchFont(`${baseUrl}/Helvetica-Black.otf`)
  } else {
    fontData = await fetchFont(`${baseUrl}/Helvetica-Light.otf`)
  }

  return { name: 'helvetica', data: fontData, weight: weight } satisfies FontOptions
}

async function fetchFont(url: string) {
  // @ts-ignore
  const res = await fetch(url, { cf: { cacheTtl: 31_536_000 } })
  return res.arrayBuffer()
}
