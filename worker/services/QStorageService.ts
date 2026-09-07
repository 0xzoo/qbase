/**
 * Q Storage Service
 *
 * S3-compatible client for Q Storage (SigV4 over Web Crypto, no AWS SDK).
 *
 * This class does not encrypt. Callers that store Secret-tier content
 * (Private / Allowlist answers, quiz session answers) go through
 * `services/secret/SecretStore`, which seals with a Worker-held key before
 * calling `put` and is the only path that opens what `get` returns. See
 * docs/specs/private-answer-encryption.md.
 */

type Env = {
  QSTORAGE_ENDPOINT: string;
  QSTORAGE_BUCKET: string;
  QSTORAGE_REGION: string;
  QSTORAGE_ACCESS_KEY: string;
  QSTORAGE_SECRET_KEY: string;
};

/** Metadata stored alongside the encrypted blob */
export interface QStorageMetadata {
  q_id: string;
  user_id: number;
  answer_type_id: number;
  audience: 'Private' | 'Allowlist';
  primary_type: string;
  created_at: string;
  allowlist_id?: string;
  allowlist?: number[];
  answer_data?: Record<string, unknown>;
}

export interface QStoragePutResult {
  success: boolean;
  key: string;
  etag?: string;
}

export interface QStorageGetResult {
  success: boolean;
  data: ArrayBuffer;
  metadata?: Record<string, string>;
  contentType?: string;
}

// --- SigV4 Implementation (Web Crypto API) ---

async function hmacSHA256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buffer = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return bufToHex(hash);
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSHA256(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  return hmacSHA256(kService, 'aws4_request');
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function toDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// URI-encode per RFC 3986 (AWS SigV4 spec)
function uriEncode(str: string, encodeSlash = true): string {
  return str.split('').map(ch => {
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' || ch === '-' || ch === '~' || ch === '.'
    ) {
      return ch;
    }
    if (ch === '/' && !encodeSlash) return ch;
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }).join('');
}

/**
 * Generate SigV4 signed headers for a request to Q Storage
 */
async function signRequest(opts: {
  method: string;
  path: string;
  host: string;
  region: string;
  accessKey: string;
  secretKey: string;
  body?: ArrayBuffer | string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  /** Query parameters, signed as the canonical query string (ListObjectsV2). */
  query?: Record<string, string>;
}): Promise<{ headers: Record<string, string>; payloadHash: string; queryString: string }> {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const service = 's3';

  // Compute payload hash
  const bodyData = opts.body
    ? (typeof opts.body === 'string' ? opts.body : opts.body)
    : '';
  const payloadHash = await sha256Hex(bodyData);

  // Build headers map (lowercase keys, sorted)
  const headersMap: Record<string, string> = {
    host: opts.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) {
    headersMap['content-type'] = opts.contentType;
  }
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      headersMap[k.toLowerCase()] = v;
    }
  }

  // Sort headers
  const sortedHeaderKeys = Object.keys(headersMap).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headersMap[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  // Canonical query string: keys sorted, each key and value URI-encoded.
  const queryString = Object.keys(opts.query ?? {})
    .sort()
    .map(k => `${uriEncode(k)}=${uriEncode(opts.query![k])}`)
    .join('&');

  // Canonical request
  const canonicalRequest = [
    opts.method,
    opts.path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Signature
  const signingKey = await getSigningKey(opts.secretKey, dateStamp, opts.region, service);
  const signatureBuf = await hmacSHA256(signingKey, stringToSign);
  const signature = bufToHex(signatureBuf);

  const credential = `${opts.accessKey}/${dateStamp}/${opts.region}/${service}/aws4_request`;

  const headers: Record<string, string> = {
    'Host': opts.host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (opts.contentType) {
    headers['Content-Type'] = opts.contentType;
  }
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      headers[k] = v;
    }
  }

  return { headers, payloadHash, queryString };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// --- Q Storage Service ---

export class QStorageService {
  private endpoint: string;
  private bucket: string;
  private region: string;
  private accessKey: string;
  private secretKey: string;
  private host: string;

  constructor(env: Env) {
    this.endpoint = env.QSTORAGE_ENDPOINT;
    this.bucket = env.QSTORAGE_BUCKET;
    this.region = env.QSTORAGE_REGION;
    this.accessKey = env.QSTORAGE_ACCESS_KEY;
    this.secretKey = env.QSTORAGE_SECRET_KEY;
    this.host = new URL(this.endpoint).host;

    if (!this.endpoint || !this.accessKey || !this.secretKey) {
      throw new Error('Q Storage configuration missing. Check QSTORAGE_* env vars.');
    }
  }

  static fromEnv(env: Env): QStorageService {
    return new QStorageService(env);
  }

  /**
   * Store an object in Q Storage as given. Secret-tier callers seal first
   * (SecretStore); this method writes whatever bytes it is handed.
   *
   * @param key - Object key (e.g., 'answers/private/{answerId}')
   * @param data - Object body
   * @param metadata - x-amz-meta-* headers for D1 cross-referencing (never content)
   * @param contentType - MIME type (default: application/octet-stream)
   */
  async put(
    key: string,
    data: ArrayBuffer | Uint8Array | string,
    metadata?: Record<string, string>,
    contentType = 'application/octet-stream'
  ): Promise<QStoragePutResult> {
    const path = `/${this.bucket}/${uriEncode(key, false)}`;

    // Convert metadata to x-amz-meta-* headers
    const extraHeaders: Record<string, string> = {};
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        extraHeaders[`x-amz-meta-${k}`] = v;
      }
    }

    const body = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data.buffer
        : data;

    const { headers } = await signRequest({
      method: 'PUT',
      path,
      host: this.host,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      body,
      contentType,
      extraHeaders,
    });

    const url = `${this.endpoint}${path}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[QStorage] PUT failed: ${response.status} ${errorBody}`);
      throw new Error(`QStorage PUT failed: ${response.status}`);
    }

    return {
      success: true,
      key,
      etag: response.headers.get('ETag') || undefined,
    };
  }

  /**
   * Retrieve an object from Q Storage as stored
   *
   * @param key - Object key
   * @returns The object body as ArrayBuffer
   */
  async get(key: string): Promise<QStorageGetResult | null> {
    const path = `/${this.bucket}/${uriEncode(key, false)}`;

    const { headers } = await signRequest({
      method: 'GET',
      path,
      host: this.host,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    });

    const url = `${this.endpoint}${path}`;
    const response = await fetch(url, { headers });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[QStorage] GET failed: ${response.status} ${errorBody}`);
      throw new Error(`QStorage GET failed: ${response.status}`);
    }

    // Extract x-amz-meta-* headers
    const metadata: Record<string, string> = {};
    for (const [k, v] of response.headers.entries()) {
      if (k.startsWith('x-amz-meta-')) {
        metadata[k.replace('x-amz-meta-', '')] = v;
      }
    }

    return {
      success: true,
      data: await response.arrayBuffer(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      contentType: response.headers.get('content-type') || undefined,
    };
  }

  /**
   * Delete an object from Q Storage
   */
  async delete(key: string): Promise<boolean> {
    const path = `/${this.bucket}/${uriEncode(key, false)}`;

    const { headers } = await signRequest({
      method: 'DELETE',
      path,
      host: this.host,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    });

    const url = `${this.endpoint}${path}`;
    const response = await fetch(url, { method: 'DELETE', headers });

    if (!response.ok && response.status !== 204) {
      console.error(`[QStorage] DELETE failed: ${response.status}`);
      return false;
    }

    return true;
  }

  /**
   * Check if an object exists (HEAD request)
   */
  async exists(key: string): Promise<boolean> {
    const path = `/${this.bucket}/${uriEncode(key, false)}`;

    const { headers } = await signRequest({
      method: 'HEAD',
      path,
      host: this.host,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    });

    const url = `${this.endpoint}${path}`;
    const response = await fetch(url, { method: 'HEAD', headers });
    return response.ok;
  }

  /**
   * List object keys under a prefix (ListObjectsV2). Q Storage's documented
   * operation list does not include it (spec §4); the caller treats a non-2xx
   * as "unsupported" and reports it rather than guessing.
   */
  async list(
    prefix: string,
    opts: { continuationToken?: string; maxKeys?: number } = {}
  ): Promise<{ keys: string[]; nextToken?: string; truncated: boolean }> {
    const path = `/${this.bucket}`;
    const query: Record<string, string> = {
      'list-type': '2',
      'prefix': prefix,
      'max-keys': String(opts.maxKeys ?? 200),
    };
    if (opts.continuationToken) query['continuation-token'] = opts.continuationToken;

    const { headers, queryString } = await signRequest({
      method: 'GET',
      path,
      host: this.host,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      query,
    });

    const url = `${this.endpoint}${path}?${queryString}`;
    const response = await fetch(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      console.error(`[QStorage] LIST failed: ${response.status} ${text.slice(0, 300)}`);
      throw new Error(`QStorage LIST failed: ${response.status} ${text.slice(0, 200)}`);
    }

    const keys = [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map(m => decodeXml(m[1]));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
    const nextMatch = text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    return { keys, truncated, nextToken: nextMatch ? decodeXml(nextMatch[1]) : undefined };
  }

  // --- Convenience methods for answer storage ---

  /**
   * Store an encrypted private answer
   * Key format: answers/private/{answerId}
   */
  async storePrivateAnswer(
    answerId: string,
    encryptedBlob: ArrayBuffer | Uint8Array | string,
    metadata: QStorageMetadata
  ): Promise<QStoragePutResult> {
    const key = `answers/private/${answerId}`;
    const metaHeaders: Record<string, string> = {
      'q-id': metadata.q_id,
      'user-id': String(metadata.user_id),
      'answer-type-id': String(metadata.answer_type_id),
      'audience': metadata.audience,
      'primary-type': metadata.primary_type,
      'created-at': metadata.created_at,
    };
    if (metadata.allowlist_id) metaHeaders['allowlist-id'] = metadata.allowlist_id;
    if (metadata.allowlist) metaHeaders['allowlist'] = JSON.stringify(metadata.allowlist);

    return this.put(key, encryptedBlob, metaHeaders);
  }

  /**
   * Retrieve an encrypted private answer
   */
  async getPrivateAnswer(answerId: string): Promise<QStorageGetResult | null> {
    return this.get(`answers/private/${answerId}`);
  }

  /**
   * Store an encrypted allowlist answer
   * Key format: answers/allowlist/{answerId}
   */
  async storeAllowlistAnswer(
    answerId: string,
    encryptedBlob: ArrayBuffer | Uint8Array | string,
    metadata: QStorageMetadata
  ): Promise<QStoragePutResult> {
    const key = `answers/allowlist/${answerId}`;
    const metaHeaders: Record<string, string> = {
      'q-id': metadata.q_id,
      'user-id': String(metadata.user_id),
      'answer-type-id': String(metadata.answer_type_id),
      'audience': metadata.audience,
      'primary-type': metadata.primary_type,
      'created-at': metadata.created_at,
    };
    if (metadata.allowlist_id) metaHeaders['allowlist-id'] = metadata.allowlist_id;
    if (metadata.allowlist) metaHeaders['allowlist'] = JSON.stringify(metadata.allowlist);

    return this.put(key, encryptedBlob, metaHeaders);
  }

  /**
   * Retrieve an encrypted allowlist answer
   */
  async getAllowlistAnswer(answerId: string): Promise<QStorageGetResult | null> {
    return this.get(`answers/allowlist/${answerId}`);
  }

  /**
   * Store anonymous attribution (encrypted mapping of public_id -> author_id)
   * Key format: attributions/{publicId}
   */
  async storeAttribution(
    publicId: string,
    encryptedBlob: ArrayBuffer | Uint8Array | string,
    authorType: 'question' | 'answer' | 'direct_query'
  ): Promise<QStoragePutResult> {
    const key = `attributions/${publicId}`;
    return this.put(key, encryptedBlob, { 'author-type': authorType });
  }

  /**
   * Retrieve an attribution record
   */
  async getAttribution(publicId: string): Promise<QStorageGetResult | null> {
    return this.get(`attributions/${publicId}`);
  }
}
