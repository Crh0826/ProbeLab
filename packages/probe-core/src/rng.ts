import { sha256Hex, canonicalJson } from './canonical.js';
import type { RandomSource } from './types.js';

export function deriveCaseSeed(rootSeed: string, mapId: string, caseId: string, probeId: string): string {
  return deriveSeed(rootSeed, mapId, caseId, probeId);
}

export function deriveSeed(...parts: string[]): string {
  if (parts.length === 0 || parts.some((part) => typeof part !== 'string')) throw new TypeError('deriveSeed requires one or more strings');
  return sha256Hex(canonicalJson(parts));
}

export function createRandomSource(seed: string): RandomSource {
  const digest = sha256Hex(`probelab/xoshiro128ss-v1\0${seed}`);
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i++) state[i] = Number.parseInt(digest.slice(i * 8, i * 8 + 8), 16) >>> 0;
  if (state.every((value) => value === 0)) state[0] = 1;
  const rotateLeft = (value: number, shift: number) => ((value << shift) | (value >>> (32 - shift))) >>> 0;
  return {
    nextUint32(): number {
      const s0 = state[0] ?? 0; const s1 = state[1] ?? 0; const s2 = state[2] ?? 0; const s3 = state[3] ?? 0;
      const result = Math.imul(rotateLeft(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
      const t = (s1 << 9) >>> 0;
      state[2] = (s2 ^ s0) >>> 0;
      state[3] = (s3 ^ s1) >>> 0;
      state[1] = (s1 ^ (state[2] ?? 0)) >>> 0;
      state[0] = (s0 ^ (state[3] ?? 0)) >>> 0;
      state[2] = ((state[2] ?? 0) ^ t) >>> 0;
      state[3] = rotateLeft(state[3] ?? 0, 11);
      return result;
    },
    nextFloat(): number { return this.nextUint32() / 0x1_0000_0000; },
    snapshot() { return { algorithm: 'xoshiro128ss-v1' as const, state: [state[0] ?? 0, state[1] ?? 0, state[2] ?? 0, state[3] ?? 0] as [number, number, number, number] }; },
  };
}
