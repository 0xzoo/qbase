/**
 * FarcasterHubWriter — reaction messages + channel parent URL (Track C card C5).
 *
 * The encoder is hand-rolled protobuf, so these tests decode the bytes with a
 * tiny reader and pin the field layout against @farcaster/core's message.proto
 * (MessageData.reaction_body = 7; ReactionBody.type = 1, target_cast_id = 2),
 * then check the envelope: hash = blake3-160(data_bytes), signer = the key's
 * public key, signature verifies over the hash.
 */

import { describe, it, expect } from 'vitest';
import { blake3 } from '@noble/hashes/blake3';
import { ed25519 } from '@noble/curves/ed25519';
import {
  makeCastAddMessage,
  makeReactionAddMessage,
  makeReactionRemoveMessage,
  hexToBytes,
  bytesToHex,
  MessageType,
  ReactionType,
} from '../../worker/services/FarcasterHubWriter';

// Deterministic 32-byte test key (never registered anywhere).
const SIGNER_KEY = '0x' + '11'.repeat(32);
const TARGET_HASH = '0x' + 'ab'.repeat(20);

// ---------------------------------------------------------------------------
// Minimal protobuf reader — enough to walk our own messages.
// ---------------------------------------------------------------------------

type Field = { field: number; wire: number; varint?: number; bytes?: Uint8Array };

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, pos];
    shift += 7;
  }
}

function decode(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, pos] = readVarint(buf, pos);
      out.push({ field, wire, varint: v });
    } else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      out.push({ field, wire, bytes: buf.slice(pos, pos + len) });
      pos += len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return out;
}

const one = (fields: Field[], n: number) => {
  const hits = fields.filter(f => f.field === n);
  expect(hits.length, `field ${n} once`).toBe(1);
  return hits[0];
};

function envelope(encoded: Uint8Array) {
  const msg = decode(encoded);
  const data = decode(one(msg, 1).bytes!);
  const hash = one(msg, 2).bytes!;
  const dataBytes = one(msg, 7).bytes!;
  const signature = one(msg, 4).bytes!;
  const signer = one(msg, 6).bytes!;
  return { msg, data, hash, dataBytes, signature, signer };
}

describe('FarcasterHubWriter reactions', () => {
  it('ReactionAdd: type 3, ReactionBody in field 7 with LIKE + target CastId', () => {
    const encoded = makeReactionAddMessage(
      { type: 'like', targetHash: TARGET_HASH, targetAuthorFid: 975961 },
      { fid: 514282, network: 1, timestamp: 123456 },
      SIGNER_KEY,
    );
    const { data, hash, dataBytes, signature, signer } = envelope(encoded);

    expect(one(data, 1).varint).toBe(MessageType.REACTION_ADD);
    expect(one(data, 2).varint).toBe(514282);
    expect(one(data, 3).varint).toBe(123456);
    expect(one(data, 4).varint).toBe(1);
    expect(data.some(f => f.field === 5)).toBe(false); // no cast_add_body

    const body = decode(one(data, 7).bytes!);
    expect(one(body, 1).varint).toBe(ReactionType.LIKE);
    const castId = decode(one(body, 2).bytes!);
    expect(one(castId, 1).varint).toBe(975961);
    expect(bytesToHex(one(castId, 2).bytes!)).toBe(TARGET_HASH);
    expect(body.some(f => f.field === 3)).toBe(false); // no target_url

    // Envelope: blake3-160 over data_bytes, signed by the key's public half.
    expect(bytesToHex(hash)).toBe(bytesToHex(blake3(dataBytes, { dkLen: 20 })));
    expect(bytesToHex(signer)).toBe(bytesToHex(ed25519.getPublicKey(hexToBytes(SIGNER_KEY))));
    expect(ed25519.verify(signature, hash, signer)).toBe(true);
    expect(one(decode(encoded), 3).varint).toBe(1); // hashScheme BLAKE3
    expect(one(decode(encoded), 5).varint).toBe(1); // signatureScheme ED25519
  });

  it('ReactionRemove: type 4; recast maps to RECAST', () => {
    const encoded = makeReactionRemoveMessage(
      { type: 'recast', targetHash: TARGET_HASH, targetAuthorFid: 7 },
      { fid: 9, network: 1, timestamp: 1 },
      SIGNER_KEY,
    );
    const { data } = envelope(encoded);
    expect(one(data, 1).varint).toBe(MessageType.REACTION_REMOVE);
    const body = decode(one(data, 7).bytes!);
    expect(one(body, 1).varint).toBe(ReactionType.RECAST);
  });

  it('is deterministic for a fixed timestamp (same bytes twice)', () => {
    const a = makeReactionAddMessage({ type: 'like', targetHash: TARGET_HASH, targetAuthorFid: 1 }, { fid: 2, network: 1, timestamp: 5 }, SIGNER_KEY);
    const b = makeReactionAddMessage({ type: 'like', targetHash: TARGET_HASH, targetAuthorFid: 1 }, { fid: 2, network: 1, timestamp: 5 }, SIGNER_KEY);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

describe('FarcasterHubWriter channel casts', () => {
  it('CastAdd with parentUrl writes CastAddBody.parent_url (field 7) and no parent_cast_id', () => {
    const encoded = makeCastAddMessage(
      { text: 'hi', parentUrl: 'https://warpcast.com/~/channel/qbase' },
      { fid: 975961, network: 1, timestamp: 1 },
      SIGNER_KEY,
    );
    const { data } = envelope(encoded);
    expect(one(data, 1).varint).toBe(MessageType.CAST_ADD);
    const body = decode(one(data, 5).bytes!);
    expect(new TextDecoder().decode(one(body, 7).bytes!)).toBe('https://warpcast.com/~/channel/qbase');
    expect(new TextDecoder().decode(one(body, 4).bytes!)).toBe('hi');
    expect(body.some(f => f.field === 3)).toBe(false);
  });

  it('a reply ignores parentUrl in favour of parent_cast_id', () => {
    const encoded = makeCastAddMessage(
      { text: 'hi', parentHash: TARGET_HASH, parentAuthorFid: 42, parentUrl: 'https://x' },
      { fid: 975961, network: 1, timestamp: 1 },
      SIGNER_KEY,
    );
    const { data } = envelope(encoded);
    const body = decode(one(data, 5).bytes!);
    expect(body.some(f => f.field === 7)).toBe(false);
    const parent = decode(one(body, 3).bytes!);
    expect(one(parent, 1).varint).toBe(42);
  });
});
