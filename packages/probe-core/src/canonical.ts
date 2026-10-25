import type { DataDTO, SimulationDescriptor, SpecialNumber, StateDTO } from './types.js';

export interface DataLimits { maxDepth?: number; maxNodes?: number; maxArrayLength?: number; maxStringLength?: number; maxBytes?: number }

const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (node: unknown): string => {
    if (node === null) return 'null';
    if (typeof node === 'string') return JSON.stringify(node);
    if (typeof node === 'boolean') return node ? 'true' : 'false';
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new TypeError('canonical JSON requires finite numbers');
      return Object.is(node, -0) ? '0' : JSON.stringify(node);
    }
    if (typeof node !== 'object') throw new TypeError(`unsupported canonical value: ${typeof node}`);
    if (seen.has(node)) throw new TypeError('cyclic canonical data');
    seen.add(node);
    try {
      if (Array.isArray(node)) return `[${node.map(visit).join(',')}]`;
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical objects must be plain data objects');
      const keys = Object.keys(node).sort(compareCodePoints);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${visit((node as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally {
      seen.delete(node);
    }
  };
  return visit(value);
}

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0; let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left.codePointAt(leftIndex) ?? 0; const b = right.codePointAt(rightIndex) ?? 0;
    if (a !== b) return a - b;
    leftIndex += a > 0xffff ? 2 : 1; rightIndex += b > 0xffff ? 2 : 1;
  }
  return (left.length - leftIndex) - (right.length - rightIndex);
}

export function utf8Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(utf8Length(value));
  let offset = 0;
  for (let i = 0; i < value.length; i++) {
    const first = value.charCodeAt(i);
    let cp = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(i + 1);
      if (second >= 0xdc00 && second <= 0xdfff) { cp = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00; i++; }
      else cp = 0xfffd;
    } else if (first >= 0xdc00 && first <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) bytes[offset++] = cp;
    else if (cp < 0x800) { bytes[offset++] = 0xc0 | (cp >> 6); bytes[offset++] = 0x80 | (cp & 0x3f); }
    else if (cp < 0x10000) { bytes[offset++] = 0xe0 | (cp >> 12); bytes[offset++] = 0x80 | ((cp >> 6) & 0x3f); bytes[offset++] = 0x80 | (cp & 0x3f); }
    else { bytes[offset++] = 0xf0 | (cp >> 18); bytes[offset++] = 0x80 | ((cp >> 12) & 0x3f); bytes[offset++] = 0x80 | ((cp >> 6) & 0x3f); bytes[offset++] = 0x80 | (cp & 0x3f); }
  }
  return bytes;
}

export function utf8Length(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const first = value.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else if (first >= 0xd800 && first <= 0xdfff) length += 3;
    else if (first < 0x80) length++;
    else if (first < 0x800) length += 2;
    else length += 3;
  }
  return length;
}

export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++] ?? 0;
    let cp: number;
    if (a < 0x80) cp = a;
    else if (a >= 0xc2 && a <= 0xdf && i < bytes.length) {
      const b = bytes[i] ?? 0;
      if ((b & 0xc0) === 0x80) { i++; cp = ((a & 0x1f) << 6) | (b & 0x3f); }
      else throw new TypeError('invalid UTF-8 continuation byte');
    } else if (a >= 0xc2 && a <= 0xdf) {
      throw new TypeError('truncated UTF-8 sequence');
    } else if (a >= 0xe0 && a <= 0xef && i + 1 < bytes.length) {
      const b = bytes[i] ?? 0; const c = bytes[i + 1] ?? 0;
      if ((b & 0xc0) === 0x80 && (c & 0xc0) === 0x80 && !(a === 0xe0 && b < 0xa0) && !(a === 0xed && b >= 0xa0)) {
        i += 2; cp = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f);
      } else throw new TypeError('invalid UTF-8 sequence');
    } else if (a >= 0xf0 && a <= 0xf4 && i + 2 < bytes.length) {
      const b = bytes[i] ?? 0; const c = bytes[i + 1] ?? 0; const d = bytes[i + 2] ?? 0;
      if ((b & 0xc0) === 0x80 && (c & 0xc0) === 0x80 && (d & 0xc0) === 0x80 && !(a === 0xf0 && b < 0x90) && !(a === 0xf4 && b >= 0x90)) {
        i += 3; cp = ((a & 7) << 18) | ((b & 0x3f) << 12) | ((c & 0x3f) << 6) | (d & 0x3f);
      } else throw new TypeError('invalid UTF-8 sequence');
    } else if (a >= 0xe0 && a <= 0xef) {
      throw new TypeError('truncated UTF-8 sequence');
    } else if (a >= 0xf0 && a <= 0xf4) throw new TypeError('truncated UTF-8 sequence');
    else throw new TypeError('invalid UTF-8 leading byte');
    out += String.fromCodePoint(cp);
  }
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);
  const k = SHA_K;
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0; const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i++) {
      const e1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + e1 + ch + (k[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const a0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (a0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, '0')).join('');
}

const SHA_K = Uint32Array.from([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

export function canonicalHash(value: unknown): string { return sha256Hex(canonicalJson(value)); }

export function assertDataDTO(value: unknown, limits: DataLimits = {}): asserts value is DataDTO {
  assertJSON(value, limits, '');
}

export function assertStateDTO(value: unknown, descriptor: SimulationDescriptor, limits: DataLimits = {}): asserts value is StateDTO {
  assertJSON(value, limits, '', new Set(descriptor.numericPaths));
  for (const path of descriptor.numericPaths) {
    const field = getPointer(value, path);
    if (typeof field !== 'number' && !isSpecialNumber(field)) throw new TypeError(`required numeric state field missing or invalid at ${path}`);
    if (typeof field === 'number' && !Number.isFinite(field)) throw new TypeError(`untagged non-finite state number at ${path}`);
  }
}

export function assertFiniteStateDTO(value: unknown, descriptor: SimulationDescriptor, limits: DataLimits = {}): asserts value is StateDTO {
  assertStateDTO(value, descriptor, limits);
  for (const path of descriptor.numericPaths) {
    const field = getPointer(value, path);
    if (typeof field !== 'number' || !Number.isFinite(field)) throw new TypeError(`initial state must contain finite numeric fields at ${path}`);
  }
}

function assertJSON(root: unknown, limits: DataLimits, allowedSpecialPath?: string, allowedPaths?: Set<string>): void {
  const maxDepth = limits.maxDepth ?? 96; const maxNodes = limits.maxNodes ?? 1_000_000;
  const maxArrayLength = limits.maxArrayLength ?? 250_000; const maxStringLength = limits.maxStringLength ?? 1_000_000;
  const seen = new Set<object>(); let nodes = 0;
  const walk = (value: unknown, depth: number, path: string): void => {
    nodes++;
    if (nodes > maxNodes) throw new RangeError('data node limit exceeded');
    if (depth > maxDepth) throw new RangeError('data depth limit exceeded');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      if (value.length > maxStringLength) throw new RangeError('string length limit exceeded');
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number is not permitted at ${path || '/'}`);
      return;
    }
    if (typeof value !== 'object') throw new TypeError(`non-data value is not permitted at ${path || '/'}`);
    if (seen.has(value)) throw new TypeError(`cyclic value at ${path || '/'}`);
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`arrays must use the standard prototype at ${path || '/'}`);
        if (value.length > maxArrayLength) throw new RangeError('array length limit exceeded');
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(String(key))) || (key !== 'length' && Number(key) >= value.length))) throw new TypeError(`array has non-index properties at ${path || '/'}`);
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new TypeError(`array hole at ${path}/${i}`);
          walk(value[i], depth + 1, `${path}/${i}`);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`non-plain object at ${path || '/'}`);
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === 'symbol')) throw new TypeError(`symbol keys are not permitted at ${path || '/'}`);
      const keys = Object.keys(value);
      if (ownKeys.length !== keys.length) throw new TypeError(`non-enumerable object keys are not permitted at ${path || '/'}`);
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) throw new TypeError(`accessor properties are not permitted at ${path}/${escapePointer(key)}`);
      }
      if (keys.some((key) => RESERVED.has(key))) throw new TypeError(`reserved object key at ${path || '/'}`);
      if (keys.includes('$probeNumber')) {
        if (keys.length !== 1) throw new TypeError(`malformed special number tag at ${path || '/'}`);
        if (!allowedPaths?.has(path || '/')) throw new TypeError(`special number tag is forbidden at ${path || '/'}`);
        if (!isSpecialNumber(value)) throw new TypeError(`unknown or malformed special number tag at ${path || '/'}`);
        return;
      }
      for (const key of keys) walk((value as Record<string, unknown>)[key], depth + 1, `${path}/${escapePointer(key)}`);
    } finally { seen.delete(value); }
  };
  walk(root, 0, allowedSpecialPath ?? '');
  if (limits.maxBytes !== undefined && utf8Bytes(canonicalJson(root)).length > limits.maxBytes) throw new RangeError('data byte limit exceeded');
}

export function isSpecialNumber(value: unknown): value is SpecialNumber {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && Object.getPrototypeOf(value) === Object.prototype &&
    ['$probeNumber'].every((key) => key in record) && ['NaN', '+Infinity', '-Infinity'].includes(String(record.$probeNumber));
}

export function getPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) throw new TypeError(`invalid JSON pointer: ${pointer}`);
  let current = root;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) throw new TypeError(`invalid JSON pointer escape: ${pointer}`);
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function escapePointer(value: string): string { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
