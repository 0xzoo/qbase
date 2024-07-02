// import { DynamicContextProvider, DynamicWidget } from '@dynamic-labs/sdk-react-core'
// import { EthereumWalletConnectors } from "@dynamic-labs/ethereum"
// import { FC } from 'hono/jsx'
// import { Hono } from 'hono'
// import { CoinbaseWalletSDK } from '@coinbase/wallet-sdk'
 
// const sdk = new CoinbaseWalletSDK({
//   appName: 'qbase',
//   appChainIds: [8453]
// });

// const app = new Hono()

// const Layout: FC = (props) => {
//   return (
//     <html>
//       <body>
//         <DynamicContextProvider
//           settings={{
//             environmentId: '52f6ed96-9757-435d-9840-fb5e2ee09d50',
//             walletConnectors: [EthereumWalletConnectors],
//           }}>
//           <DynamicWidget />
//           {props.children}
//         </DynamicContextProvider>
//       </body>
//     </html>
//   )
// }

// app.get('/', (c) => {
//   const messages = ['Good Morning', 'Good Evening', 'Good Night']
//   return c.html(<Layout messages={messages} />)
//   // return c.html(<Top messages={messages} />)
// })

// export default app
