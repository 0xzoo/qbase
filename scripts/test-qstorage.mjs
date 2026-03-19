/**
 * Q Storage Presigned URL Prototype
 * Tests SigV4 presigned URLs against Quilibrium's S3-compatible API
 * Uses only Web Crypto / Node built-in crypto (CF Workers compatible)
 */

import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Load .dev.vars directly
function loadDevVars() {
  try {
    const text = readFileSync('.dev.vars', 'utf8');
    const get = (key) => {
      const m = text.match(new RegExp(`^${key}=(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^"|"$/g, '') : null;
    };
    return {
      endpoint: get('QSTORAGE_ENDPOINT') || 'https://qstorage.quilibrium.com',
      bucket: get('QSTORAGE_BUCKET') || 'qbase',
      region: get('QSTORAGE_REGION') || 'q-world-1',
      accessKey: get('QSTORAGE_ACCESS_KEY'),
      secretKey: get('QSTORAGE_SECRET_KEY'),
      service: 's3',
    };
  } catch (e) {
    console.error('Cannot read .dev.vars:', e.message);
    process.exit(1);
  }
}

const CONFIG = loadDevVars();

if (!CONFIG.accessKey || !CONFIG.secretKey) {
  console.error('Missing QSTORAGE_ACCESS_KEY or QSTORAGE_SECRET_KEY');
  process.exit(1);
}

console.log('Config:', {
  endpoint: CONFIG.endpoint,
  bucket: CONFIG.bucket,
  region: CONFIG.region,
  accessKey: CONFIG.accessKey.slice(0, 8) + '...',
});

// --- SigV4 Implementation (CF Workers compatible) ---

function hmacSHA256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSHA256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSHA256(kDate, region);
  const kService = hmacSHA256(kRegion, service);
  const kSigning = hmacSHA256(kService, 'aws4_request');
  return kSigning;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function toDateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Generate a SigV4 presigned URL
 */
// URI-encode per RFC 3986 (AWS SigV4 spec)
function uriEncode(str, encodeSlash = true) {
  return str.split('').map(ch => {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-' || ch === '~' || ch === '.') {
      return ch;
    }
    if (ch === '/' && !encodeSlash) return ch;
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }).join('');
}

function presignUrl({ method, bucket, key, region, accessKey, secretKey, service, endpoint, expiresIn = 3600, contentType }) {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credential = `${accessKey}/${dateStamp}/${region}/${service}/aws4_request`;
  
  // Path-style URL: endpoint/bucket/key
  const canonicalPath = `/${bucket}/${uriEncode(key, false)}`;
  const host = new URL(endpoint).host;
  
  // Build canonical query string manually with proper encoding
  // Must be sorted by param name, URI-encoded
  const qsParams = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  qsParams.sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQueryString = qsParams.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
  
  // Canonical request
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  
  console.log('  [debug] Canonical Request:\n', canonicalRequest.replace(/\n/g, '\n  '));
  
  // String to sign
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  
  // Signature
  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  
  // Final URL - append signature
  return `${endpoint}${canonicalPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Generate SigV4 signed headers for direct requests
 */
function signRequest({ method, bucket, key, region, accessKey, secretKey, service, endpoint, body = '', contentType = '' }) {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const host = new URL(endpoint).host;
  const path = `/${bucket}/${key}`;
  
  const payloadHash = sha256Hex(body);
  
  let canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  let signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  
  if (contentType) {
    canonicalHeaders = `content-type:${contentType}\n${canonicalHeaders}`;
    signedHeaders = `content-type;${signedHeaders}`;
  }
  
  const canonicalRequest = [
    method,
    path,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  
  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const credential = `${accessKey}/${dateStamp}/${region}/${service}/aws4_request`;
  
  const headers = {
    'Host': host,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (contentType) headers['Content-Type'] = contentType;
  
  return { url: `${endpoint}${path}`, headers };
}

// --- Tests ---

async function testHeadBucket() {
  console.log('\n=== Test 1: HEAD Bucket (connectivity check) ===');
  const { url, headers } = signRequest({
    method: 'HEAD',
    bucket: CONFIG.bucket,
    key: '',
    ...CONFIG,
  });
  // HEAD bucket is actually at /bucket level
  const headUrl = `${CONFIG.endpoint}/${CONFIG.bucket}`;
  try {
    const resp = await fetch(headUrl, {
      method: 'HEAD',
      headers,
    });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    console.log('Headers:', Object.fromEntries(resp.headers));
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

async function testListBucket() {
  console.log('\n=== Test 2: LIST Bucket (signed request) ===');
  const { url, headers } = signRequest({
    method: 'GET',
    bucket: CONFIG.bucket,
    key: '',
    ...CONFIG,
  });
  try {
    const actualUrl = `${CONFIG.endpoint}/${CONFIG.bucket}`;
    const resp = await fetch(actualUrl, { headers });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    const body = await resp.text();
    console.log('Response (first 500 chars):', body.slice(0, 500));
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

async function testPutObject() {
  console.log('\n=== Test 3: PUT Object (signed request) ===');
  const testBody = 'hello from qbase presign test - ' + new Date().toISOString();
  const { url, headers } = signRequest({
    method: 'PUT',
    bucket: CONFIG.bucket,
    key: 'test/presign-test.txt',
    body: testBody,
    contentType: 'text/plain',
    ...CONFIG,
  });
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers,
      body: testBody,
    });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    const respBody = await resp.text();
    if (respBody) console.log('Response:', respBody.slice(0, 500));
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

async function testGetObject() {
  console.log('\n=== Test 4: GET Object (signed request) ===');
  const { url, headers } = signRequest({
    method: 'GET',
    bucket: CONFIG.bucket,
    key: 'test/presign-test.txt',
    ...CONFIG,
  });
  try {
    const resp = await fetch(url, { headers });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    const body = await resp.text();
    console.log('Body:', body);
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

async function testPresignedPut() {
  console.log('\n=== Test 5: Presigned PUT URL ===');
  const url = presignUrl({
    method: 'PUT',
    bucket: CONFIG.bucket,
    key: 'test/presigned-test.txt',
    ...CONFIG,
    expiresIn: 300,
  });
  console.log('Presigned URL:', url.slice(0, 120) + '...');
  
  // Actually use it
  const testBody = 'presigned upload test - ' + new Date().toISOString();
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      body: testBody,
    });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    const respBody = await resp.text();
    if (respBody) console.log('Response:', respBody.slice(0, 500));
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

async function testPresignedGet() {
  console.log('\n=== Test 6: Presigned GET URL ===');
  const url = presignUrl({
    method: 'GET',
    bucket: CONFIG.bucket,
    key: 'test/presigned-test.txt',
    ...CONFIG,
    expiresIn: 300,
  });
  console.log('Presigned URL:', url.slice(0, 120) + '...');
  
  try {
    const resp = await fetch(url);
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    const body = await resp.text();
    console.log('Body:', body);
    return resp.status < 400;
  } catch (e) {
    console.error('Error:', e.message);
    return false;
  }
}

// Run all tests
async function main() {
  console.log('\n🚀 Q Storage Presigned URL Prototype\n');
  
  const results = [];
  
  results.push(['HEAD Bucket', await testHeadBucket()]);
  results.push(['LIST Bucket', await testListBucket()]);
  results.push(['PUT Object (signed)', await testPutObject()]);
  results.push(['GET Object (signed)', await testGetObject()]);
  results.push(['PUT (presigned URL)', await testPresignedPut()]);
  results.push(['GET (presigned URL)', await testPresignedGet()]);
  
  console.log('\n\n=== RESULTS ===');
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  }
  
  const allPassed = results.every(([, ok]) => ok);
  console.log(`\n${allPassed ? '🎉 All tests passed!' : '⚠️  Some tests failed'}`);
}

main().catch(console.error);
