import { Frog } from 'frog'
import { devtools } from 'frog/dev'
import { serveStatic } from 'frog/serve-static'
import coinFrame from './frames/coin'
import amaFrame from './frames/ama'
import createAmaFrame from './frames/createAma'
import actionsFrame from './frames/actions'
import { Home } from './web/home'
import { Mint } from './web/mint'
import { D1Database } from '@cloudflare/workers-types'
import { getShareableQPng } from './api/img/png'
import { getTokenMetadata } from './api/viem/onchain'
// import {
//   // bump,
//   // chargeUser,
//   getOrCreateUser,
//   // payUser,
//   // updateUserName
// } from './api/db/d1'
// import {
//   addDocEntry,
//   getCount,
//   // getQ,
//   queryForSimilar
// } from './api/db/bagel'
// import {
//   getCastData,
//   // getFarcasterUserProfile,
//   validateAction
// } from './api/airstack/hub'
// import { AddDocResponse, Q, QEntry, QQueryResponse } from './api/db/types'

export type Env = {
  AIRSTACK_API_KEY: string,
  BAGELDB_API_KEY: string,
  BAGELDB_USER_ID: string,
  BAGELDB_CLUSTER_ID: string,
  DB: D1Database,
}

export const app = new Frog<{ Bindings: Env }>({
  title: 'qbase',
  origin: 'https://qbase.tech'
})

// frames
app.route('/coin', coinFrame)
app.route('/ama', amaFrame)
app.route('/createAma', createAmaFrame)
app.route('/frame', actionsFrame)

// web
// app.hono.route('/home', qbase)
app.get('/', (c) => c.html(<Home />))
app.get('/mint', (c) => c.html(<Mint />))

// app.get('/api/userUp/:fid', async (c) => {
//   try {
//     const { fid } = c.req.param()
//     const updated = await updateUserName(fid, c.env.DB)
//     console.log('updated', updated)
//     c.status(200)
//     return c.text(updated ? 'true' : 'false')
//   } catch (err) {
//     console.log(err)
//   }
// })
// app.get('/api/bump', async (c) => {
//   try {
//     const bumped = await bump(c.env.DB)
//     console.log('bumped', bumped)
//     c.status(200)
//     c.text(bumped ? 'true' : 'false')
//     return c.res
//   } catch (err) {
//     console.log(err)
//   }
// })
// app.get('/api/count', async (c) => {
//   try {
//     const count = await getCount(c.env)
//     console.log('count', count)
//     c.status(200)
//     return c.text(count.toString())
//   } catch (err) {
//     console.log(err)
//   }
// })
// app.get('/q/:qid/data', async (c) => {
//   try {
//     const { qid } = c.req.param()
//     const qData = await getQ(qid, c.env)
//     console.log(`q${qid}`, qData)
//     c.header('Content-Type', 'text/plain')
//     c.status(200)
//     return c.text(qData)
//   } catch (err) {
//     console.log('q/data err', err)
//   }
// })
app.get('/q/:qid/img.png', async (c) => {
  try {
    const { qid } = c.req.param()
    const pngImg = await getShareableQPng(qid, c.env)
    c.status(200)
    c.header('Content-Type', 'image/png')
    c.header('og:title', `qbase - q${qid}`)
    c.header('og:image:width', String(1200))
    c.header('og:image:height', String(630))
    c.header('og:image', origin)
    return pngImg
  } catch (err) {
    return new Response(JSON.stringify(err), { status: 500 })
  }
})

app.get('/token/:tokenId', async (c) => {
  try {
    const { tokenId } = c.req.param()
    const token = await getTokenMetadata(tokenId)
    c.status(200)
    return c.json(token)
  } catch (err) {
    return new Response(JSON.stringify(err), { status: 500 })
  }
})

// app.castAction('/coinToss', async (c) => {
//   const body = await c.req.json()
//   console.log('hit')

//   const {
//     isValid,
//     message,
//     interactedByFid,
//     // castedByFid
//   } = await validateAction(body)
//   const castHash = message.data.frameActionBody.castId.hash
//   if (isValid) {
//     const coiner = await getOrCreateUser(interactedByFid, c.env.DB)
//     // if not enough qp, no dice
//     if (coiner.points_balance < 2) return c.res({ message: `you dont have enough qp :(` })
//     // const trueCoiner = await getOrCreateUser(castedByFid, c.env.DB)
//     const castText = await getCastText(castHash)
//     console.log('castText', castText)
//     return c.res({ message: 'yayy' })
//     // const qSimilars: QQueryResponse = await queryForSimilar(castText as string, c.env)
//     // const nearestSimilar = qSimilars.distances && qSimilars.distances[0][0] as number
//     // // const nearestSimilarMetadata: Q = (qSimilars.metadatas && qSimilars.metadatas[0][0]) as unknown as Q
//     // // console.log('qSimilars', qSimilars)

//     // // check for previous qs
//     // let alreadyCoined: boolean
//     // if (nearestSimilar == null) {
//     //   throw Error('trouble connecting to db. please try again')
//     // } else if (nearestSimilar > .99) {
//     //   alreadyCoined = true
//     // } else {
//     //   alreadyCoined = false
//     // }

//     // if (alreadyCoined) {
//     //   // and owner is caster, pay caster 1 point. something diff if already stolen?
//     //   // if (Number(nearestSimilarMetadata.coiner_fid) == castedByFid) {
//     //   await chargeUser(coiner, 'tip', c.env.DB)
//     //   await payUser(trueCoiner, 1, c.env.DB)
//     //   return c.json({ message: `already coined. you tipped ${trueCoiner.fname} 1qp` })
//     // } else {
//     //   const qCount = await getCount(c.env)
//     //   const timestamp = Date.now()
//     //   const nextQCount = qCount + 1
//     //   const { profileName } = await getFarcasterUserProfile(interactedByFid)
//     //   const qMetadata: Q[] = [
//     //     {
//     //       id: nextQCount.toString(),
//     //       created_at: timestamp,
//     //       coiner_name: profileName,
//     //       coiner_id: trueCoiner.id,
//     //       coiner_fid: trueCoiner.fid?.toString(),
//     //       owner_id: coiner.id
//     //     }
//     //   ]
//     //   const qToAdd: QEntry = {
//     //     metadatas: qMetadata,
//     //     documents: [castText]
//     //   }
//     //   const deductedPoints = await chargeUser(coiner, 'coin', c.env.DB)
//     //   if (deductedPoints) {
//     //     const qBaseResult: AddDocResponse = await addDocEntry(qToAdd, c.env)
//     //     if (qBaseResult !== true) {
//     //       throw new Error(qBaseResult.detail[0].msg)
//     //     }
//     //   }
//     //   return c.json({ message: `you coined this q!` })
//     // }
//   } else {
//     return c.res({ message: 'noooo' })
//   }
// })

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
