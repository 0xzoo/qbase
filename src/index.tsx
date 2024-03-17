import { Frog } from 'frog'
import { handle } from 'frog/vercel'
import { getFont } from './fonts.js'
import { homeScreen } from './frames/ama/home.js'
import { askScreen } from './frames/ama/ask.js'
import { qSuccess } from './frames/ama/qSuccess.js'
import { Home } from './web/home.js'
import { generateImage } from './api/img/generateImage.js'

// Uncomment to use Edge Runtime.
// export const config = {
//   runtime: 'edge',
// }

type State = {
  anon: boolean
}

export const app = new Frog<{ State: State }>({
  assetsPath: '/assets',
  basePath: '/',
  hub: process.env.NODE_ENV === "production"
    ? {
      apiUrl: "https://hubs.airstack.xyz",
      fetchOptions: {
        headers: {
          "x-airstack-hubs": "",
        }
      }
    } : undefined,
  imageOptions: async () => {
    const helvetica = await getFont(400)
    const helveticaBold = await getFont(600)
    const helveticaBlack = await getFont(700)

    return {
      width: 1200,
      height: 1200,
      fonts: [helvetica, helveticaBold, helveticaBlack],
    }
  },
  imageAspectRatio: '1:1',
  initialState: {

  }
})

app.get('/ama/api/img/:sender/:stem/img.png', async (c) => {
  // if question has been asked
  const { sender, stem } = c.req.param()
  const pngImg = await generateImage(sender, stem)
  const { origin } = new URL(c.req.url)

  return new Response(pngImg, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'og:title': stem[12],
      'og:image:width': String(1200),
      'og:image:height': String(1200),
      'og:image': origin
    }
  })
  // else return 500
})


app.get('/', (ctx) => ctx.html(<Home />))
app.frame('/ama/:fid', homeScreen)
app.frame('/ama/:fid/ask', askScreen)
app.frame('/ama/:fid/qSuccess', qSuccess)
// app.transaction('/tx', transaction)

export const GET = handle(app)
export const POST = handle(app)
