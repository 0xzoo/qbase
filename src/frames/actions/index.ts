import {
  FrameContext,
  Frog,
  TransactionContext,
} from 'frog'
import { getFont } from '../../fonts'
import { devtools } from 'frog/dev'
import { serveStatic } from 'frog/serve-static'
import addActionScreen from './addAction'
import actionsHomeScreen from './actionsHome'
import coinStartScreen from './coinStart'
import coinFlipScreen from './coinFlip'
import coinNewScreen from './coinNew'
import coinCheckScreen from './coinCheck'
import coinFinishScreen from './coinFinish'
import seeQsScreen from './seeQs'
import mintStartScreen from './mintStart'
import mintFinishScreen from './mintFinish'
// import saveAnswerScreen from './saveAnswer'
import { Env } from '../..'
import { AIRSTACK_API_KEY } from '../../api/airstack/key'
import { abi } from '../../api/viem/abi'
import { qNFTContractAddress } from '../../api/viem/onchain'
// import { getCastData, getFarcasterProfileName, validateAction } from '../../api/airstack/hub'
// import { chargeUser, getOrCreateUser, payUser } from '../../api/db/d1'
// import { AddDocResponse, Q, QEntry, QQueryResponse } from '../../api/db/types'
// import { addDocEntry, getCount, queryForSimilar } from '../../api/db/bagel'

export type State = {
  q: string,
  qToMint: string,
  qCount: number
}

type FrogOptions = {
  Bindings: Env,
  State: State
}

export type CustomFrameContext = FrameContext<FrogOptions>
export type CustomTransactionContext = TransactionContext<FrogOptions>

export const app = new Frog<FrogOptions>({
  title: 'qbase frame',
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
  },
  initialState: {
    q: '',
    qCount: -1,
    qToMint: ''
  }
})

app.frame('/add', addActionScreen)
app.frame('/', actionsHomeScreen)
app.frame('/coin', coinStartScreen)
app.frame('/coin/flip', coinFlipScreen)
app.frame('/coin/new', coinNewScreen)
app.frame('/coin/check', coinCheckScreen)
app.frame('/coin/finish', coinFinishScreen)
app.frame('/seeQs', seeQsScreen)
app.frame('/mint/start', mintStartScreen)
app.frame('/mint/finish', mintFinishScreen)
// app.frame('/answer', saveAnswerScreen)
// app.frame('/answer/finish', answerFinishScreen)

app.transaction('/mint', (c) => {
  const { previousState } = c
  const { qToMint } = previousState
  return c.contract({
    abi,
    chainId: 'eip155:8453',
    functionName: 'mint',
    args: [qToMint],
    to: qNFTContractAddress
  })
})

app.castAction(
  '/actions',
  (c) => {
    return c.res({
      type: 'frame',
      path: '/home'
    })
  },
  {
    name: 'qbase',
    icon: 'question'
  }
)

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
