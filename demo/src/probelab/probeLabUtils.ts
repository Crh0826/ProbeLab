import type { DebugWorld, FailureKind } from '@probelab/core';
import type { CoverageSummary, CaseViewResult, StoredCase } from './types.js';

export const EMPTY_WORLD: DebugWorld = { mapId: 'pending', coordinateSystem: 'x-right/y-up/z-forward', units: 'world units', colliders: [] };
export const MAPS = [
  { id: 'foundry', label: 'Foundry · 铸造厂' },
  { id: 'dust', label: 'Dust · 沙丘' },
  { id: 'vault', label: 'Vault · 冷库' },
];
export const SCENARIOS = [
  { id: 'healthy', label: '健康探索' },
  { id: 'drop', label: '演示缺陷 · 越界' },
  { id: 'penetration', label: '演示缺陷 · 穿透' },
  { id: 'non-finite', label: '演示缺陷 · 非有限状态' },
] as const;
export const FAILURE_LABEL: Record<FailureKind, string> = {
  'out-of-bounds': '地图越界',
  penetration: '碰撞穿透',
  'non-finite-state': '数值异常',
  'invalid-start': '非法起点',
};

export function seedFor(rootSeed: string, targetId: string, map: string, index: number): string {
  return `${rootSeed.trim() || 'probe-seed'}/${targetId}/${map}/${String(index).padStart(2, '0')}`;
}

export function coverageOf(cases: ReadonlyMap<string, StoredCase>, world: DebugWorld | undefined): CoverageSummary | undefined {
  const bounds = world?.bounds;
  if (bounds === undefined) return undefined;
  const xRange = bounds.max[0] - bounds.min[0];
  const zRange = bounds.max[2] - bounds.min[2];
  if (!(xRange > 0 && zRange > 0)) return undefined;
  const side = 8;
  const visited = new Set<string>();
  for (const { result } of cases.values()) {
    for (const frame of result.trace) {
      const position = frame.position;
      if (position === undefined || !position.every(Number.isFinite)) continue;
      const x = Math.max(0, Math.min(side - 1, Math.floor(((position[0] - bounds.min[0]) / xRange) * side)));
      const z = Math.max(0, Math.min(side - 1, Math.floor(((position[2] - bounds.min[2]) / zRange) * side)));
      visited.add(`${x}:${z}`);
    }
  }
  return { visited: visited.size, total: side * side, percent: (visited.size / (side * side)) * 100 };
}

export function toTrack(id: string, stored: StoredCase) {
  const { result } = stored;
  const failure = result.failure ?? result.invalidStart;
  const failureFrame = failure === undefined ? undefined : result.trace.find((frame) => frame.tick === failure.tick && frame.position !== undefined) ?? result.trace.filter((frame) => frame.tick < failure.tick && frame.position !== undefined).at(-1);
  return {
    id,
    label: id,
    trace: result.trace.map((frame) => ({ tick: frame.tick, position: frame.position, actorBounds: frame.actorBounds, state: frame.state, command: frame.command })),
    ...(failure === undefined ? {} : {
      failure: {
        kind: failure.kind,
        tick: failure.tick,
        target: failure.signature.target,
        position: failureFrame?.position,
      },
    }),
  };
}

export function failurePosition(result: Pick<CaseViewResult, 'failure' | 'invalidStart' | 'trace'>): [number, number, number] | undefined {
  const failure = result.failure ?? result.invalidStart;
  if (failure === undefined) return undefined;
  return result.trace.find((frame) => frame.tick === failure.tick && frame.position !== undefined)?.position ?? result.trace.filter((frame) => frame.tick < failure.tick && frame.position !== undefined).at(-1)?.position;
}

export function readGeometryWarnings(world: DebugWorld | undefined): string[] {
  const metadata = world?.metadata;
  if (metadata === null || metadata === undefined || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const warnings = (metadata as Record<string, unknown>)['geometryWarnings'];
  if (!Array.isArray(warnings)) return [];
  return warnings.map((warning) => {
    if (typeof warning === 'string') return warning;
    if (warning !== null && typeof warning === 'object' && !Array.isArray(warning)) {
      const item = warning as Record<string, unknown>;
      const label = item['message'] ?? item['label'] ?? item['id'];
      if (typeof label === 'string') return label;
    }
    return JSON.stringify(warning);
  });
}
