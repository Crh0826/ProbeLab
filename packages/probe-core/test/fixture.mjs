export const descriptor = {
  protocolVersion: 1,
  adapterId: 'test/box-sim',
  adapterVersion: '1.0.0',
  simulationVersion: 'fixture-v1',
  implementationHash: 'fixture-hash-v1',
  buildId: 'test-build',
  stateVersion: 'state-v1',
  commandVersion: 'command-v1',
  worldVersion: 'world-v1',
  configVersion: 'config-v1',
  startVersion: 'start-v1',
  tickRate: 60,
  coordinateSystem: 'right-handed-y-up',
  units: 'meters',
  numericPaths: ['/position/0', '/position/1', '/position/2', '/velocity/0', '/velocity/1', '/velocity/2', '/height'],
  oracleVersion: 'probe-oracle-v1',
};

export const world = {
  mapId: 'fixture-room',
  bounds: { min: [-5, 0, -5], max: [5, 5, 5] },
  colliders: [{ id: 'wall-a', bounds: { min: [2, 0, -1], max: [3, 3, 1] }, solid: true }],
};

export const config = {
  oracle: { boundsMode: 'actor', enabledAxes: ['x', 'y', 'z'], tolerance: [0, 0, 0], penetrationEpsilon: 0.001 },
};

export const start = { position: [0, 0, 0], velocity: [0, 0, 0] };

const clone = (value) => JSON.parse(JSON.stringify(value));
const decodeNumber = (value) => value && typeof value === 'object' && '$probeNumber' in value
  ? value.$probeNumber === 'NaN' ? Number.NaN : value.$probeNumber === '+Infinity' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  : value;
const encodeNumber = (value) => Number.isFinite(value) ? value : { $probeNumber: Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity' };

export function makeAdapter(overrides = {}) {
  return {
    descriptor: { ...descriptor, ...overrides.descriptor },
    encodeWorld: (value) => clone(value), decodeWorld: (value) => clone(value),
    encodeConfig: (value) => clone(value), decodeConfig: (value) => clone(value),
    encodeStart: (value) => clone(value), decodeStart: (value) => clone(value),
    encodeState: (state) => ({ position: state.position.map(encodeNumber), velocity: state.velocity.map(encodeNumber), height: encodeNumber(state.height ?? 1.8), phase: state.phase ?? 0 }),
    decodeState: (value) => ({ position: value.position.map(decodeNumber), velocity: value.velocity.map(decodeNumber), height: decodeNumber(value.height ?? 1.8), phase: value.phase ?? 0 }),
    encodeCommand: (value) => clone(value), decodeCommand: (value) => clone(value),
    toDebugWorld: (value) => ({ mapId: value.mapId, coordinateSystem: descriptor.coordinateSystem, units: descriptor.units, bounds: clone(value.bounds), colliders: clone(value.colliders) }),
    getOracleConfig: (value) => value.oracle,
    coverageCapacity: () => 16,
    createInitialState: (_world, _config, value) => ({ position: [...value.position], velocity: [...value.velocity], height: value.height ?? 1.8, phase: value.phase ?? 0 }),
    cloneState: (value) => ({ position: [...value.position], velocity: [...value.velocity], height: value.height ?? 1.8, phase: value.phase ?? 0 }),
    step: (state, command, _world, _config, _dt) => {
      const next = { position: [...state.position], velocity: [...state.velocity], height: state.height ?? 1.8, phase: state.phase ?? 0 };
      if (command.kind === 'move') {
        next.position[0] += command.dx ?? 0;
        next.position[1] += command.dy ?? 0;
        next.position[2] += command.dz ?? 0;
      } else if (command.kind === 'wall-touch') {
        next.position[0] = 1.5;
      } else if (command.kind === 'oob') {
        next.position[0] = 6;
      } else if (command.kind === 'penetrate') {
        next.position[0] = 2.2;
      } else if (command.kind === 'nonfinite') {
        next.velocity[1] = Number.NaN;
      } else if (command.kind === 'position-nan') {
        next.position[0] = Number.NaN;
      } else if (command.kind === 'position-infinity') {
        next.position[0] = Number.POSITIVE_INFINITY;
      } else if (command.kind === 'height-negative-infinity') {
        next.height = Number.NEGATIVE_INFINITY;
      } else if (command.kind === 'multi-fault') {
        next.position[0] = 6; next.velocity[1] = Number.NaN;
      } else if (command.kind === 'prepare') {
        next.phase = 1;
      } else if (command.kind === 'conditional-hit') {
        next.position[0] = next.phase ? 2.2 : 6;
      }
      return { state: next, detail: { action: command.kind } };
    },
    inspect: (state, currentWorld) => ({
      numericFields: [
        ...state.position.map((value, index) => ({ path: `/position/${index}`, value })),
        ...state.velocity.map((value, index) => ({ path: `/velocity/${index}`, value })),
        { path: '/height', value: state.height ?? 1.8 },
      ],
      position: [...state.position],
      actorBounds: { min: [state.position[0] - 0.5, state.position[1], state.position[2] - 0.5], max: [state.position[0] + 0.5, state.position[1] + (state.height ?? 1.8), state.position[2] + 0.5] },
      worldBounds: clone(currentWorld.bounds),
      colliders: clone(currentWorld.colliders),
    }),
    ...overrides.adapter,
  };
}

export function makeRequest(overrides = {}) {
  return { caseId: 'case-1', seed: 'seed-1', world: clone(world), config: clone(config), start: clone(start), maxTicks: 12, ...overrides };
}

export function sequenceStrategy(commands, neutral = { kind: 'noop' }) {
  let index = 0;
  return {
    nextCommand: () => commands[index++] ?? neutral,
    coverageKey: (inspection) => `x${Math.floor(inspection.position?.[0] ?? 0)}`,
    neutralCommand: () => clone(neutral),
  };
}

export const cloneData = clone;
