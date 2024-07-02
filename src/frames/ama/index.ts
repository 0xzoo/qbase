import {
  FrameContext,
  Frog,
  TransactionContext
} from 'frog'
import { getFont } from '../../fonts'
import { devtools } from 'frog/dev'
import { serveStatic } from 'frog/serve-static'
import { amaHomeScreen } from './amaHome'
import { amaConfirmScreen } from './amaConfirm'
import { amaSuccessScreen } from './amaSuccess'
import { amaQsScreen } from './amaQs'
import { Env } from '../..'
import { AIRSTACK_API_KEY } from '../../api/airstack/key'


export type State = {
  q: string, // input text
  qid: string | null, // if q already coined, id gets logged here
  currentQ: number, // current q in array of received direct qs
  anon: boolean, // anon or id'd
  id: number, // id of recipient/owner
  fid: number // fid of recipient/owner
}

type FrogOptions = {
  Bindings: Env,
  State: State
}

export type CustomFrameContext = FrameContext<FrogOptions>
export type CustomTransactionContext = TransactionContext<FrogOptions>

const app = new Frog<FrogOptions>({
  title: 'qbase: ama',
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
    'cache-control': 'max-age=12',
  },
  initialState: {
    q: '', // inputText
    qid: null, // qid of nearestSimilar if q already in db
    currentQ: -1, // counter for received qs
    anon: false, // if asking anon
    id: 0, // id of recipient
    fid: 0 // fid of recipient
  }
})

app.frame('/:profileName', amaHomeScreen)
app.frame('/:profileName/confirm', amaConfirmScreen)
app.frame('/:profileName/success', amaSuccessScreen)
app.frame('/:profileName/qs', amaQsScreen)

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
