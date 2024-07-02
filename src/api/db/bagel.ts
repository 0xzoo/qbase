import { Env } from "../.."
import {
  AddDocResponse,
  GetQQuery,
  GetQResponse,
  QEntry,
  QQuery,
  QQueryResponse
} from "./types.js"
const baseAPIURL = 'https://api.bageldb.ai/api/v1'
const bagelCountIsOff: boolean = false // TODO! ADJUST IF BAGELDB COUNT IS OFF

export const qbaseVersion = 'v0.1.0'

export async function heartbeat() {
  const response = await fetch('https://api.bageldb.ai/api/v1')
  const data = await response.json()
  return data
}

export async function getCount(env: Env): Promise<number> {
  try {
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/count`, {
      method: 'GET',
      headers: headers
    })
    let data: number = await response.json()
    console.log('trueCount', data)
    if (bagelCountIsOff) data-- // if bagel count is being weird
    return data
  } catch (err) {
    console.log('error:', err)
    throw err
  }
}


export async function addDocEntry(qEntry: QEntry, env: Env): Promise<AddDocResponse> {
  try {
    let {
      metadatas,
      documents,
    } = qEntry
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const id = (await getCount(env) + 1).toString()

    const fullEntry: QEntry = {
      metadatas: metadatas || null,
      documents: documents || null,
      ids: [id]
    }
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/add`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(fullEntry)
    })
    const data = await response.json()
    if (!data) {
      throw new Error("Empty response data received")
    }
    return data
  } catch (err) {
    console.log('addDoc error:', err)
    throw err
  }
}

export async function addDocAndRetrieveEmbeddings(qEntry: QEntry, env: Env) {
  try {
    const doc = await addDocEntry(qEntry, env)
    if (doc) {
      const document = qEntry.documents && qEntry.documents[0]
      if (document) {
        const docResponse = await getQByDoc(document, env)
        console.log('docResponse', docResponse)
        return docResponse
      } else {
        console.log('addDocFail')
      }
    }
  } catch (err) {
    console.log(err)
  }
}

// TODO change n_results? sort by created_at and return oldest results
export async function queryForSimilar(q: string, env: Env): Promise<QQueryResponse> {
  try {
    const qQuery: QQuery = {
      query_texts: [q],
      n_results: 2,
      include: ["metadatas", "documents", "distances"]
    }
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/query`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    const data = await response.json()
    if (!data) {
      throw new Error("Empty response data received")
    }
    return data
  } catch (err) {
    console.log('queryForSims error:', err)
    throw err
  }
}

export async function getQById(id: number, env: Env, embeddings?: boolean): Promise<GetQResponse> {
  try {
    const idString = id.toString()
    let qQuery: GetQQuery = {
      ids: [idString],
      include: [
        'metadatas',
        'documents',
      ]
    }
    if (embeddings) qQuery.include?.push('embeddings')
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/get`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    const data = await response.json()
    console.log('bageldata', data)
    if (!data) {
      throw new Error("Empty response data received")
    }
    return data
  } catch (err) {
    console.log('getQById err', err)
    throw err
  }
}

export async function getQByDoc(doc: string, env: Env): Promise<GetQResponse> {
  try {
    const qQuery: GetQQuery = {
      where_document: { doc }
    }
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/get`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    const data = await response.json()
    if (!data) {
      throw new Error("Empty response data received")
    }
    return data
  } catch (err) {
    console.log('getQByDoc err', err)
    throw err
  }
}

export async function getQ(qid: string, env: Env) {
  try {
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    let qQuery: GetQQuery = {
      ids: [qid],
      include: [
        'metadatas',
        'documents',
      ]
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/get`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    let data = await response.json()
    // console.log(data)
    return data
  } catch (err) {
    console.log('getQ err', err)
  }
}

// TODO: how to paginate?
export async function getAllQs(env: Env, offset?: number) {
  try {
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    let qQuery: GetQQuery = {
      sort: 'timestamp', // TODO: fix
      limit: 100,
      offset: offset || 0,
      include: [
        'metadatas',
        'documents',
      ]
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/get`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    let data = await response.json()
    return data
  } catch (err) {
    console.log('getAllQs err', err)
  }
}

// restrict by timestamp?
export async function getNewestQs(env: Env) {
  try {
    const {
      BAGELDB_API_KEY,
      BAGELDB_CLUSTER_ID
    } = env
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': BAGELDB_API_KEY
    }
    let qQuery: GetQQuery = {
      limit: 100,
      include: [
        'metadatas',
        'documents',
      ]
    }
    const response = await fetch(`${baseAPIURL}/clusters/${BAGELDB_CLUSTER_ID}/get`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(qQuery)
    })
    let data = await response.json()
    // console.log(data)
    return data
  } catch (err) {
    console.log('getQ err', err)
  }
}