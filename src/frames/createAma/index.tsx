import {
  FrameContext,
  Frog,
} from 'frog'
import { getFont } from '../../fonts'
import { devtools } from 'frog/dev'
import { serveStatic } from 'frog/serve-static'
import { createAmaFrame } from './createAma'
import { shareAmaFrame } from './shareAma'
import { Env } from '../..'
import { AIRSTACK_API_KEY } from '../../api/airstack/key'

type FrogOptions = {
  Bindings: Env,
}

export type CustomFrameContext = FrameContext<FrogOptions>

export const app = new Frog<FrogOptions>({
  title: 'qbase: create ama',
  hub: {
    apiUrl: "https://hubs.airstack.xyz",
    fetchOptions: {
      headers: {
        "x-airstack-hubs": AIRSTACK_API_KEY,
      }
    }
  },
  assetsPath: '/assets',
  imageOptions: async () => {
    const helvetica = await getFont(400)
    const helveticaBold = await getFont(500)
    const helveticaBlack = await getFont(600)

    return {
      fonts: [helvetica, helveticaBold, helveticaBlack]
    }
  },
  headers: {
    'cache-control': 'max-age=0',
  }
})

app.frame('/', createAmaFrame)
app.frame('/share', shareAmaFrame)

const isCloudflareWorker = typeof caches !== 'undefined'
if (isCloudflareWorker) {
  // @ts-ignore
  const manifest = await import('__STATIC_CONTENT_MANIFEST')
  //
  const serveStaticOptions = { manifest, root: './' }
  app.use('/*', serveStatic(serveStaticOptions))
  devtools(app, { assetsPath: '/frog', serveStatic, serveStaticOptions })
} else {
  devtools(app, { serveStatic })
}

export default app
