import 'dotenv/config'
import { Frog } from 'frog'
import { generateImage } from './api/img/generateImage.js'
import { Home } from './web/home.js'
import amaFrame from './frames/ama/index.js'

// Uncomment to use Edge Runtime.
// export const config = {
//   runtime: 'edge',
// }

export const app = new Frog()

app.get('/api/img/:sender/:stem/img.png', async (c) => {
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
app.route('/ama', amaFrame)

export default app