declare type Weight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
declare type Style = 'normal' | 'italic'

export interface FontOptions {
  data: Buffer | ArrayBuffer
  name: string
  weight?: Weight
  style?: Style
  lang?: string
}

export async function getFont(weight: Weight) {
  let fontData: ArrayBuffer
  const baseUrl = 'https://www.americanfilterparts.com/fonts/helvetica'

  if (weight === 400) {
    fontData = await fetchFont(`${baseUrl}/Helvetica.otf`)
  } else if (weight === 600) {
    fontData = await fetchFont(`${baseUrl}/Helvetica-Bold.otf`)
  } else {
    fontData = await fetchFont(`${baseUrl}/Helvetica-Black.otf`)
  }

  return { name: 'helvetica', data: fontData, style: 'normal' } satisfies FontOptions
}

async function fetchFont(url: string) {
  const res = await fetch(url, { cf: { cacheTtl: 31_536_000 } })
  return res.arrayBuffer()
}

// export async function getFont() {
//   let fontData: ArrayBuffer
//   fontData = await fetchFont('https://github.com/continuum/wall/blob/master/app/assets/fonts/Helvetica.otf')

//   return { name: 'Helvetica', data: fontData, style: 'normal' } satisfies FontOptions
// }