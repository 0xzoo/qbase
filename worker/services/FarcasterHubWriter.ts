/**
 * FarcasterHubWriter — minimal, Worker-safe hub message builder.
 *
 * Replaces @farcaster/core for CastAdd/CastRemove writes.
 * Uses @noble/curves/ed25519 for signing and @noble/hashes/blake3 for hashing.
 * No module-level randomness, no eval, no dynamic imports.
 */

import { blake3 } from '@noble/hashes/blake3';
import { ed25519 } from '@noble/curves/ed25519';

// ---------------------------------------------------------------------------
// Protobuf wire helpers
// ---------------------------------------------------------------------------

function writeVarint(buf: number[], val: number): void {
  while (val >= 0x80) {
    buf.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  buf.push(val);
}

function writeVarint64(buf: number[], val: number): void {
  // JavaScript safe-integer range is enough for FIDs/timestamps
  let lo = val >>> 0;
  let hi = (val / 0x100000000) >>> 0;
  while (hi > 0 || lo >= 0x80) {
    buf.push((lo & 0x7f) | 0x80);
    lo = ((lo >>> 7) | (hi << 25)) >>> 0;
    hi >>>= 7;
  }
  buf.push(lo);
}

function writeTag(buf: number[], field: number, wire: number): void {
  writeVarint(buf, (field << 3) | wire);
}

function writeBytes(buf: number[], bytes: Uint8Array): void {
  writeVarint(buf, bytes.length);
  for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]);
}

function writeString(buf: number[], str: string): void {
  const encoded = new TextEncoder().encode(str);
  writeVarint(buf, encoded.length);
  for (let i = 0; i < encoded.length; i++) buf.push(encoded[i]);
}

function writeUint32Field(buf: number[], field: number, val: number): void {
  if (val === 0) return;
  writeTag(buf, field, 0);
  writeVarint(buf, val);
}

function writeInt32Field(buf: number[], field: number, val: number): void {
  if (val === 0) return;
  writeTag(buf, field, 0);
  writeVarint(buf, val);
}

function writeUint64Field(buf: number[], field: number, val: number): void {
  if (val === 0) return;
  writeTag(buf, field, 0);
  writeVarint64(buf, val);
}

function writeBytesField(buf: number[], field: number, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  writeTag(buf, field, 2);
  writeBytes(buf, bytes);
}

function writeStringField(buf: number[], field: number, str: string): void {
  if (str === '') return;
  writeTag(buf, field, 2);
  writeString(buf, str);
}

function writeMessageField(
  buf: number[],
  field: number,
  encoder: () => Uint8Array,
): void {
  const encoded = encoder();
  if (encoded.length === 0) return;
  writeTag(buf, field, 2);
  writeVarint(buf, encoded.length);
  for (let i = 0; i < encoded.length; i++) buf.push(encoded[i]);
}

function finishBuf(buf: number[]): Uint8Array {
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const HashScheme = { NONE: 0, BLAKE3: 1 };
const SignatureScheme = { NONE: 0, ED25519: 1, EIP712: 2 };
const MessageType = {
  NONE: 0,
  CAST_ADD: 1,
  CAST_REMOVE: 2,
  REACTION_ADD: 3,
  REACTION_REMOVE: 4,
  LINK_ADD: 5,
  LINK_REMOVE: 6,
} as const;
const CastType = { CAST: 0, LONG_CAST: 1, TEN_K_CAST: 2 };

// ---------------------------------------------------------------------------
// Message encoders
// ---------------------------------------------------------------------------

interface CastId {
  fid: number;
  hash: Uint8Array;
}

function encodeCastId(msg: CastId): Uint8Array {
  const buf: number[] = [];
  writeUint64Field(buf, 1, msg.fid);
  writeBytesField(buf, 2, msg.hash);
  return finishBuf(buf);
}

interface Embed {
  url?: string;
  castId?: CastId;
}

function encodeEmbed(msg: Embed): Uint8Array {
  const buf: number[] = [];
  if (msg.url !== undefined) writeStringField(buf, 1, msg.url);
  if (msg.castId !== undefined) {
    writeMessageField(buf, 2, () => encodeCastId(msg.castId!));
  }
  return finishBuf(buf);
}

interface CastAddBody {
  embedsDeprecated?: string[];
  mentions?: number[];
  parentCastId?: CastId;
  parentUrl?: string;
  text?: string;
  mentionsPositions?: number[];
  embeds?: Embed[];
  type?: number;
}

function encodeCastAddBody(msg: CastAddBody): Uint8Array {
  const buf: number[] = [];

  for (const v of msg.embedsDeprecated ?? []) {
    writeStringField(buf, 1, v);
  }

  // mentions: always write as packed field (even if empty) to match @farcaster/core
  const mentions = msg.mentions ?? [];
  writeTag(buf, 2, 2);
  const packedMentions: number[] = [];
  for (const v of mentions) writeVarint64(packedMentions, v);
  writeVarint(buf, packedMentions.length);
  for (const b of packedMentions) buf.push(b);

  if (msg.parentCastId !== undefined) {
    writeMessageField(buf, 3, () => encodeCastId(msg.parentCastId!));
  }

  if (msg.parentUrl !== undefined) writeStringField(buf, 7, msg.parentUrl);
  if (msg.text !== undefined) writeStringField(buf, 4, msg.text);

  // mentionsPositions: always write as packed field (even if empty)
  const mentionsPositions = msg.mentionsPositions ?? [];
  writeTag(buf, 5, 2);
  const packedPositions: number[] = [];
  for (const v of mentionsPositions) writeVarint(packedPositions, v);
  writeVarint(buf, packedPositions.length);
  for (const b of packedPositions) buf.push(b);

  for (const v of msg.embeds ?? []) {
    writeMessageField(buf, 6, () => encodeEmbed(v));
  }

  writeInt32Field(buf, 8, msg.type ?? 0);

  return finishBuf(buf);
}

interface CastRemoveBody {
  targetHash: Uint8Array;
}

function encodeCastRemoveBody(msg: CastRemoveBody): Uint8Array {
  const buf: number[] = [];
  writeBytesField(buf, 1, msg.targetHash);
  return finishBuf(buf);
}

interface MessageData {
  type: number;
  fid: number;
  timestamp: number;
  network: number;
  castAddBody?: CastAddBody;
  castRemoveBody?: CastRemoveBody;
}

function encodeMessageData(msg: MessageData): Uint8Array {
  const buf: number[] = [];
  writeInt32Field(buf, 1, msg.type);
  writeUint64Field(buf, 2, msg.fid);
  writeUint32Field(buf, 3, msg.timestamp);
  writeInt32Field(buf, 4, msg.network);
  if (msg.castAddBody !== undefined) {
    writeMessageField(buf, 5, () => encodeCastAddBody(msg.castAddBody!));
  }
  if (msg.castRemoveBody !== undefined) {
    writeMessageField(buf, 6, () => encodeCastRemoveBody(msg.castRemoveBody!));
  }
  return finishBuf(buf);
}

interface Message {
  data?: MessageData;
  hash: Uint8Array;
  hashScheme: number;
  signature: Uint8Array;
  signatureScheme: number;
  signer: Uint8Array;
  dataBytes?: Uint8Array;
}

function encodeMessage(msg: Message): Uint8Array {
  const buf: number[] = [];
  if (msg.data !== undefined) {
    writeMessageField(buf, 1, () => encodeMessageData(msg.data!));
  }
  writeBytesField(buf, 2, msg.hash);
  writeInt32Field(buf, 3, msg.hashScheme);
  writeBytesField(buf, 4, msg.signature);
  writeInt32Field(buf, 5, msg.signatureScheme);
  writeBytesField(buf, 6, msg.signer);
  if (msg.dataBytes !== undefined) {
    writeBytesField(buf, 7, msg.dataBytes);
  }
  return finishBuf(buf);
}

// ---------------------------------------------------------------------------
// Farcaster time
// ---------------------------------------------------------------------------

const FARCASTER_EPOCH = 1609459200000; // 2021-01-01T00:00:00.000Z

function getFarcasterTime(): number {
  return Math.round((Date.now() - FARCASTER_EPOCH) / 1000);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

class Ed25519Signer {
  scheme = SignatureScheme.ED25519;
  privateKey: Uint8Array;

  constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
  }

  getSignerKey(): Uint8Array {
    return ed25519.getPublicKey(this.privateKey);
  }

  signMessageHash(hash: Uint8Array): Uint8Array {
    return ed25519.sign(hash, this.privateKey);
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export interface CastAddParams {
  text: string;
  embeds?: Array<{ url: string }>;
  parentHash?: string;
  parentAuthorFid?: number;
}

export interface CastRemoveParams {
  targetHash: string;
}

export interface MessageResult {
  hash: string;
  author_fid: number;
  text: string;
}

export interface DataOptions {
  fid: number;
  network: number;
  timestamp?: number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function makeCastAddMessage(
  params: CastAddParams,
  dataOptions: DataOptions,
  signerKeyHex: string,
): Uint8Array {
  const timestamp = dataOptions.timestamp ?? getFarcasterTime();

  const embeds: Embed[] = [];
  for (const e of params.embeds ?? []) {
    embeds.push({ url: e.url });
  }

  const castAddBody: CastAddBody = {
    embedsDeprecated: [],
    mentions: [],
    mentionsPositions: [],
    embeds,
    text: params.text,
    type: CastType.CAST,
  };

  if (params.parentHash && params.parentAuthorFid) {
    castAddBody.parentCastId = {
      fid: params.parentAuthorFid,
      hash: hexToBytes(params.parentHash),
    };
  }

  const messageData: MessageData = {
    type: MessageType.CAST_ADD,
    fid: dataOptions.fid,
    timestamp,
    network: dataOptions.network,
    castAddBody,
  };

  const dataBytes = encodeMessageData(messageData);
  const hash = blake3(dataBytes, { dkLen: 20 });

  const signer = new Ed25519Signer(hexToBytes(signerKeyHex));
  const signature = signer.signMessageHash(hash);
  const signerKey = signer.getSignerKey();

  const message: Message = {
    data: messageData,
    dataBytes,
    hash,
    hashScheme: HashScheme.BLAKE3,
    signature,
    signatureScheme: SignatureScheme.ED25519,
    signer: signerKey,
  };

  return encodeMessage(message);
}

export function makeCastRemoveMessage(
  params: CastRemoveParams,
  dataOptions: DataOptions,
  signerKeyHex: string,
): Uint8Array {
  const timestamp = dataOptions.timestamp ?? getFarcasterTime();

  const castRemoveBody: CastRemoveBody = {
    targetHash: hexToBytes(params.targetHash),
  };

  const messageData: MessageData = {
    type: MessageType.CAST_REMOVE,
    fid: dataOptions.fid,
    timestamp,
    network: dataOptions.network,
    castRemoveBody,
  };

  const dataBytes = encodeMessageData(messageData);
  const hash = blake3(dataBytes, { dkLen: 20 });

  const signer = new Ed25519Signer(hexToBytes(signerKeyHex));
  const signature = signer.signMessageHash(hash);
  const signerKey = signer.getSignerKey();

  const message: Message = {
    data: messageData,
    dataBytes,
    hash,
    hashScheme: HashScheme.BLAKE3,
    signature,
    signatureScheme: SignatureScheme.ED25519,
    signer: signerKey,
  };

  return encodeMessage(message);
}

export { bytesToHex };
