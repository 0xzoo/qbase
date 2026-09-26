/**
 * Post a wave bundle to Arweave through ArDrive Turbo (plan 2026-09-25 §8.7).
 *
 * The bundle goes up as one ANS-104 data item signed by qbase's **archive
 * key** (secp256k1, `ARCHIVE_PRIVATE_KEY`, not the ENS writer), so anyone can
 * check a bundle came from qbase's archive address. Turbo accepts items under
 * 100 KiB without credits; a wave bundle is kilobytes.
 *
 * Why not `@ardrive/turbo-sdk`: its web build does run in workerd (spike
 * 2026-09-26: it bundles with `nodejs_compat` once its optional `x402-fetch`
 * peer is aliased away, and a real upload from local workerd succeeded), but
 * it adds ~3.6 MB to the worker for one POST. This file builds the same bytes
 * the SDK's EthereumSigner builds (ANS-104: signature type 3, personal_sign
 * over the deep hash, uncompressed public key as owner; checked byte for byte
 * against `@dha-team/arbundles` 1.0.4) and posts them to the endpoint the SDK
 * uses.
 */

import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const TURBO_UPLOAD_URL = 'https://upload.ardrive.io/v1/tx/ethereum';
/** Gateways that serve a Turbo item before it settles into an Arweave block, then the canonical one. */
export const ARWEAVE_GATEWAYS = ['https://turbo-gateway.com', 'https://arweave.net'];
export const FREE_UPLOAD_LIMIT = 100 * 1024;

const SIGNATURE_TYPE_ETHEREUM = 3;
const enc = new TextEncoder();

export interface Tag { name: string; value: string }

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function sha384(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-384', data));
}

/** Arweave's deep hash over a blob or a (nested) list of blobs. */
export async function deepHash(data: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
  if (Array.isArray(data)) {
    let acc = await sha384(concat([enc.encode('list'), enc.encode(String(data.length))]));
    for (const chunk of data) acc = await sha384(concat([acc, await deepHash(chunk)]));
    return acc;
  }
  const tag = concat([enc.encode('blob'), enc.encode(String(data.byteLength))]);
  return sha384(concat([await sha384(tag), await sha384(data)]));
}

/** Avro zigzag varint (a `long`). */
function avroLong(n: number): Uint8Array {
  let z = BigInt(n) >= 0n ? BigInt(n) << 1n : ((-BigInt(n)) << 1n) - 1n;
  const out: number[] = [];
  do {
    let b = Number(z & 0x7fn);
    z >>= 7n;
    if (z > 0n) b |= 0x80;
    out.push(b);
  } while (z > 0n);
  return Uint8Array.from(out);
}

function avroBytes(b: Uint8Array): Uint8Array {
  return concat([avroLong(b.length), b]);
}

/** ANS-104 tags: an Avro array of {name: bytes, value: bytes}; empty when there are none. */
export function encodeTags(tags: Tag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);
  return concat([
    avroLong(tags.length),
    ...tags.flatMap((t) => [avroBytes(enc.encode(t.name)), avroBytes(enc.encode(t.value))]),
    avroLong(0),
  ]);
}

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export interface SignedItem { id: string; raw: Uint8Array; owner: Hex; address: Hex }

/** Build and sign an ANS-104 data item (no target, no anchor) with an Ethereum key. */
export async function signDataItem(privateKey: Hex, data: Uint8Array, tags: Tag[]): Promise<SignedItem> {
  const account = privateKeyToAccount(privateKey);
  const owner = hexToBytes(account.publicKey); // 65 bytes, 0x04-prefixed
  const rawTags = encodeTags(tags);
  const message = await deepHash([
    enc.encode('dataitem'),
    enc.encode('1'),
    enc.encode(String(SIGNATURE_TYPE_ETHEREUM)),
    owner,
    new Uint8Array(0), // target
    new Uint8Array(0), // anchor
    rawTags,
    data,
  ]);
  const signature = hexToBytes(await account.signMessage({ message: { raw: message } }));
  const sigType = new Uint8Array(2);
  new DataView(sigType.buffer).setUint16(0, SIGNATURE_TYPE_ETHEREUM, true);
  const raw = concat([
    sigType,
    signature,
    owner,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    u64le(tags.length),
    u64le(rawTags.length),
    rawTags,
    data,
  ]);
  const id = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', signature)));
  return { id, raw, owner: bytesToHex(owner), address: account.address };
}

export interface ArchiveEnv { ARCHIVE_PRIVATE_KEY?: string }

export class ArweaveUnavailable extends Error {}

/** Post the bundle; returns the data item id. Throws `ArweaveUnavailable` when no key is set or the item is over the free limit. */
export async function postBundle(env: ArchiveEnv, json: string, tags: Tag[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = env.ARCHIVE_PRIVATE_KEY;
  if (!key) throw new ArweaveUnavailable('ARCHIVE_PRIVATE_KEY is not set');
  const data = enc.encode(json);
  const item = await signDataItem((key.startsWith('0x') ? key : `0x${key}`) as Hex, data, tags);
  if (item.raw.length > FREE_UPLOAD_LIMIT) throw new ArweaveUnavailable(`bundle is ${item.raw.length} bytes, over Turbo's free ${FREE_UPLOAD_LIMIT}`);
  const res = await fetchImpl(TURBO_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: item.raw,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Turbo upload ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { id?: string };
  if (body.id !== item.id) throw new Error(`Turbo returned id ${body.id}, expected ${item.id}`);
  return item.id;
}

/** Fetch a data item's bytes from the first gateway that serves it. */
export async function fetchFromArweave(id: string, fetchImpl: typeof fetch = fetch): Promise<{ text: string; gateway: string } | null> {
  for (const gw of ARWEAVE_GATEWAYS) {
    try {
      const res = await fetchImpl(`${gw}/${id}`, { redirect: 'follow' });
      if (res.ok) return { text: await res.text(), gateway: gw };
    } catch {
      // try the next gateway
    }
  }
  return null;
}

/** ENSIP-7 contenthash for an Arweave id: the `arweave` multicodec (0xb29910, varint 0x90b2ca05) then the 32 id bytes. */
export function arweaveContenthash(id: string): Hex {
  const bytes = base64urlDecode(id);
  if (bytes.length !== 32) throw new Error(`Arweave id must decode to 32 bytes, got ${bytes.length}`);
  return `0x90b2ca05${bytesToHex(bytes).slice(2)}`;
}
