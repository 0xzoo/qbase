// import { Ai } from "@cloudflare/ai"

// export interface Env {
//   AI: Ai
// }

// export async function tokenize(text: string, env: Env) {
//   const ai = new Ai(env.AI)

//   const embeddings = await ai.run(
//     "@cf/baai/bge-base-en-v1.5",
//     {
//       text: text,
//     }
//   )
//   console.log('embeddings', embeddings)

//   return embeddings
// }

// import { Ai } from "@cloudflare/ai"

// export interface Env {
//   AI: Ai
// }

// export default {
//   async fetch(request: Request, env: Env) {
//     console.log('req', request)
// const ai = new Ai(env.AI)

// Can be a string or array of strings]
// const stories = [
//   "This is a story about an orange cloud",
//   "This is a story about a llama",
//   "This is a story about a hugging emoji",
// ];

// const embeddings = await ai.run(
//   "@cf/baai/bge-base-en-v1.5",
//   {
//     text: request,
//   }
// );

// return Response.json(embeddings)
//   },
// };

// async function run(model: string, input: any) {
//   const response = await fetch(
//     `https://api.cloudflare.com/client/v4/accounts/09f3be5733db9856bd5f3b318e4a35de/ai/run/${model}`,
//     {
//       headers: { Authorization: "Bearer {API_TOKEN}" },
//       method: "POST",
//       body: JSON.stringify(input),
//     }
//   );
//   const result = await response.json();
//   return result;
// }

// run("@cf/meta/llama-2-7b-chat-int8", {
//   messages: [
//     {
//       role: "system",
//       content: "You are a friendly assistan that helps write stories",
//     },
//     {
//       role: "user",
//       content:
//         "Write a short story about a llama that goes on a journey to find an orange cloud ",
//     },
//   ],
// }).then((response) => {
//   console.log(JSON.stringify(response));
// });