import { Frog } from 'frog'
import { getFont } from '../../fonts.js'
import { homeScreen } from './home.js'
import { askScreen } from './ask.js'
import { qSuccess } from './qSuccess.js'
import 'dotenv/config'

// Uncomment to use Edge Runtime.
// export const config = {
//   runtime: 'edge',
// }

type State = {
  anon: boolean
}

console.log('vercel_env', process.env.VERCEL_ENV)

export const app = new Frog<{ State: State }>({
  assetsPath: '/assets',
  hub: process.env.VERCEL_ENV === "production"
    ? {
      apiUrl: "https://hubs.airstack.xyz",
      fetchOptions: {
        headers: {
          "x-airstack-hubs": process.env.AIRSTACK_API_KEY || "",
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
    anon: false
  }
})

// app.get('/', (ctx) => ctx.html(<Home />))
app.frame(':fid', homeScreen)
app.frame(':fid/ask', askScreen)
app.frame(':fid/qSuccess', qSuccess)
// app.transaction('/tx', transaction)

export default app