/**
 * Canonical JSON (RFC 8785, JCS) for the data a wave bundle carries: objects
 * with keys sorted by UTF-16 code units, no whitespace, strings and numbers
 * serialised the way ECMAScript's JSON.stringify does (which is what JCS
 * specifies). `undefined` members are dropped, as JSON.stringify drops them.
 * Non-finite numbers have no JSON form and are refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot serialise ${typeof value}`);
  }
}

/** Lowercase hex sha256 of a UTF-8 string, 0x-prefixed (the form the chain record carries). */
export async function sha256Hex(text: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
