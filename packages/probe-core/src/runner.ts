import { assertDataDTO, assertFiniteStateDTO, assertStateDTO, canonicalHash, canonicalJson, compareCodePoints } from './canonical.js';
import { createInspectionCache, firstOracleHit, inspectAndValidate, signature, validateOracleConfig } from './oracle.js';
import { createRandomSource } from './rng.js';
import type { CaseResult, CommandStrategy, CoverageSnapshot, DataDTO, DebugWorld, Inspection, OracleConfig, ProbeAdapter, RunController, RunRequest, StateDTO, TickSummary } from './types.js';

export function createRunController<State>(adapter: ProbeAdapter<State>, request: RunRequest, strategy: CommandStrategy<State>): RunController<State> {
  validateRequest(adapter, request);
  const worldData = cloneData(adapter.encodeWorld(request.world));
  const configData = cloneData(adapter.encodeConfig(request.config));
  const startData = cloneData(adapter.encodeStart(request.start));
  assertDataDTO(worldData); assertDataDTO(configData); assertDataDTO(startData);
  const frozenObjects = new WeakSet<object>();
  const world = deepFreeze(adapter.decodeWorld(cloneData(worldData)), new Set(), frozenObjects);
  const config = deepFreeze(adapter.decodeConfig(cloneData(configData)), new Set(), frozenObjects);
  const start = deepFreeze(adapter.decodeStart(cloneData(startData)), new Set(), frozenObjects);
  const worldHash = canonicalHash(worldData); const configHash = canonicalHash(configData);
  const oracle = cloneOracle(adapter.getOracleConfig(config));
  const inspectionCache = createInspectionCache(adapter);
  const debugWorld = validateDebugWorld(adapter.toDebugWorld(world), adapter.descriptor);
  const encodedDebugWorld = cloneData(debugWorld as unknown as DataDTO) as unknown as DebugWorld;
  const state = adapter.createInitialState(world, config, start);
  const initialState = encodeFiniteState(adapter, state);
  const rng = createRandomSource(request.seed + '\0' + request.caseId);
  const rngInitial = rng.snapshot();
  const capacityRaw = adapter.coverageCapacity?.(world, config, start);
  if (capacityRaw !== undefined && (!Number.isInteger(capacityRaw) || capacityRaw < 1)) throw new TypeError('coverageCapacity must return a positive integer');
  const visits: Record<string, number> = Object.create(null) as Record<string, number>;
  const result: CaseResult = {
    caseId: request.caseId, seed: request.seed, rngInitial, rngFinal: rng.snapshot(), initialState,
    inputs: { world: cloneData(worldData), config: cloneData(configData), start: cloneData(startData), debugWorld: encodedDebugWorld, worldHash, configHash },
    coverage: { visits, visited: 0, ...(capacityRaw === undefined ? {} : { capacity: capacityRaw, ratio: 0 }) },
    status: request.maxTicks === 0 ? 'complete' : 'running', ticksExecuted: 0, trace: [],
  };
  let currentState = state;
  let currentInspection: Inspection;
  try {
    currentInspection = inspectState(adapter, currentState, world, config, oracle, inspectionCache, frozenObjects);
    const adapterStart = adapter.validateStart?.(deepFreeze(adapter.cloneState(currentState), new Set(), frozenObjects), world, config);
    if (adapterStart && !adapterStart.valid) {
      const detail = { reason: adapterStart.reason ?? 'adapter rejected initial state' } as DataDTO;
      result.status = 'failed';
      result.invalidStart = { kind: 'invalid-start', tick: 0, signature: signature('invalid-start', `adapter:${adapterStart.reason ?? 'rejected'}`), detail, state: initialState };
    } else {
      const hit = firstOracleHit(currentInspection, oracle, true);
      if (hit) {
        result.status = 'failed';
        result.invalidStart = { kind: 'invalid-start', tick: 0, signature: signature('invalid-start', hit.target), detail: hit.detail as DataDTO, state: initialState };
      }
    }
  } catch (error) {
    result.status = 'failed'; result.error = errorRecord(error, 0);
    currentInspection = { numericFields: [] };
  }
  let coverageTotal = 0;
  let coverageVisited = 0;
  const coverageVisitsView: Readonly<Record<string, number>> = new Proxy(visits, {
    set() { throw new TypeError('coverage visits are read-only in strategy context'); },
    deleteProperty() { throw new TypeError('coverage visits are read-only in strategy context'); },
    defineProperty() { throw new TypeError('coverage visits are read-only in strategy context'); },
    setPrototypeOf() { throw new TypeError('coverage visits are read-only in strategy context'); },
  });
  const coverageContext: CoverageSnapshot = Object.freeze({
    get visits() { return coverageVisitsView; },
    get total() { return coverageTotal; },
    get visited() { return coverageVisited; },
    ...(capacityRaw === undefined ? {} : { capacity: capacityRaw, get ratio() { return Math.min(1, coverageVisited / capacityRaw); } }),
  });
  const noteCoverage = (inspection: Inspection): void => {
    const key = strategy.coverageKey?.(inspection);
    if (key === undefined) return;
    if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new TypeError('coverageKey must be a non-empty bounded string');
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError('coverageKey uses a reserved data key');
    const previous = visits[key];
    visits[key] = (previous ?? 0) + 1;
    coverageTotal++;
    if (previous === undefined) coverageVisited++;
    result.coverage.visited = coverageVisited;
    if (capacityRaw !== undefined) result.coverage.ratio = Math.min(1, coverageVisited / capacityRaw);
  };
  const setError = (error: unknown, tick: number): void => { result.status = 'failed'; result.error = errorRecord(error, tick); };
  const controller: RunController<State> = {
    get result() { result.rngFinal = rng.snapshot(); return result; },
    get currentState() { return adapter.cloneState(currentState); },
    advance(maxTicks: number): CaseResult {
      if (!Number.isSafeInteger(maxTicks) || maxTicks < 0) throw new RangeError('advance maxTicks must be a non-negative safe integer');
      if (result.status !== 'running' || maxTicks === 0) return this.result;
      for (let count = 0; count < maxTicks && result.status === 'running'; count++) {
        const tick = result.ticksExecuted + 1;
        try {
          const commandObject = strategy.nextCommand({ caseId: request.caseId, tick, seed: request.seed, rng, state: deepFreeze(adapter.cloneState(currentState), new Set(), frozenObjects), inspection: currentInspection, coverage: coverageContext, ...(result.trace.length ? { previousCommand: result.trace[result.trace.length - 1]?.command } : {}) });
          const commandData = cloneData(adapter.encodeCommand(commandObject)); assertDataDTO(commandData);
          const command = deepFreeze(adapter.decodeCommand(cloneData(commandData)), new Set(), frozenObjects);
          const stepInput = deepFreeze(adapter.cloneState(currentState), new Set(), frozenObjects);
          const stepInputHash = canonicalHash(adapter.encodeState(stepInput));
          const commandHash = canonicalHash(adapter.encodeCommand(command));
          const observation = adapter.step(stepInput, command, world, config, 1 / adapter.descriptor.tickRate);
          if (canonicalHash(adapter.encodeState(stepInput)) !== stepInputHash) throw new Error('adapter.step mutated input state');
          if (canonicalHash(adapter.encodeCommand(command)) !== commandHash) throw new Error('adapter.step mutated input command');
          if (!observation || !('state' in observation)) throw new TypeError('adapter.step must return {state}');
          currentState = observation.state;
          currentInspection = inspectState(adapter, currentState, world, config, oracle, inspectionCache, frozenObjects);
          const stateDTO = encodeState(adapter, currentState);
          const stateHash = canonicalHash(stateDTO);
          const entry: TickSummary = {
            tick, command: commandData, state: stateDTO, stateHash,
            ...(currentInspection.position && currentInspection.position.every(Number.isFinite) ? { position: [...currentInspection.position] as [number, number, number] } : {}),
            ...(isFiniteAABB(currentInspection.actorBounds) ? { actorBounds: { min: [...currentInspection.actorBounds.min] as [number, number, number], max: [...currentInspection.actorBounds.max] as [number, number, number] } } : {}),
            ...(observation.detail === undefined ? {} : { detail: cloneData(observation.detail) }),
          };
          result.trace.push(entry); result.ticksExecuted = tick;
          noteCoverage(currentInspection);
          const hit = firstOracleHit(currentInspection, oracle);
          if (hit) {
            result.status = 'failed';
            result.failure = { kind: hit.kind, tick, signature: signature(hit.kind, hit.target), detail: hit.detail as DataDTO, state: stateDTO };
          } else if (tick >= request.maxTicks) result.status = 'complete';
        } catch (error) { setError(error, tick); }
        result.rngFinal = rng.snapshot();
      }
      return this.result;
    },
    pause(): CaseResult { if (result.status === 'running') result.status = 'paused'; return this.result; },
    resume(): CaseResult { if (result.status === 'paused') result.status = 'running'; return this.result; },
    cancel(reason?: string): CaseResult { if (result.status === 'running' || result.status === 'paused') { result.status = 'cancelled'; if (reason) result.cancelReason = reason; } return this.result; },
  };
  return controller;
}

export function runCase<State>(adapter: ProbeAdapter<State>, request: RunRequest, strategy: CommandStrategy<State>): CaseResult {
  const controller = createRunController(adapter, request, strategy);
  while (controller.result.status === 'running') controller.advance(Math.min(256, request.maxTicks - controller.result.ticksExecuted));
  return controller.result;
}

export function encodeState<State>(adapter: ProbeAdapter<State>, state: State): StateDTO {
  const encoded = adapter.encodeState(state);
  assertStateDTO(encoded, adapter.descriptor);
  return JSON.parse(canonicalJson(encoded)) as StateDTO;
}

function inspectState<State>(adapter: ProbeAdapter<State>, state: State, world: unknown, config: unknown, oracle: OracleConfig, cache: ReturnType<typeof createInspectionCache>, frozenObjects: WeakSet<object>): Inspection {
  const snapshot = deepFreeze(adapter.cloneState(state), new Set(), frozenObjects);
  const before = canonicalHash(adapter.encodeState(snapshot));
  const inspection = inspectAndValidate(adapter, snapshot, world, config, oracle, cache);
  if (canonicalHash(adapter.encodeState(snapshot)) !== before) throw new Error('adapter.inspect mutated input state');
  return deepFreeze(inspection, new Set(), frozenObjects);
}

function encodeFiniteState<State>(adapter: ProbeAdapter<State>, state: State): StateDTO {
  const encoded = adapter.encodeState(state);
  assertFiniteStateDTO(encoded, adapter.descriptor);
  return JSON.parse(canonicalJson(encoded)) as StateDTO;
}

function cloneData<T extends DataDTO>(value: T): T {
  assertDataDTO(value);
  return JSON.parse(canonicalJson(value)) as T;
}

function cloneOracle(oracle: OracleConfig): OracleConfig {
  validateOracleConfig(oracle);
  return { boundsMode: oracle.boundsMode, enabledAxes: [...oracle.enabledAxes], tolerance: [...oracle.tolerance] as [number, number, number], penetrationEpsilon: oracle.penetrationEpsilon };
}

function validateDebugWorld(world: DebugWorld, descriptor: ProbeAdapter['descriptor']): DebugWorld {
  assertDataDTO(world as unknown as DataDTO);
  if (!world || typeof world.mapId !== 'string' || !world.mapId || world.coordinateSystem !== descriptor.coordinateSystem || world.units !== descriptor.units || !Array.isArray(world.colliders)) throw new TypeError('invalid DebugWorld descriptor or colliders');
  if (world.bounds && !isFiniteAABB(world.bounds)) throw new TypeError('DebugWorld bounds must be a finite ordered AABB');
  const ids = new Set<string>();
  for (const collider of world.colliders) {
    if (!collider.id || ids.has(collider.id) || typeof collider.solid !== 'boolean' || !isFiniteAABB(collider.bounds)) throw new TypeError('DebugWorld collider IDs and boxes must be valid');
    ids.add(collider.id);
  }
  for (const label of world.labels ?? []) if (!label.id || !label.label || label.position.some((part) => !Number.isFinite(part))) throw new TypeError('DebugWorld labels must have finite positions');
  return { ...world, colliders: [...world.colliders].sort((a, b) => compareCodePoints(a.id, b.id)), ...(world.labels ? { labels: [...world.labels].sort((a, b) => compareCodePoints(a.id, b.id)) } : {}) };
}

function validateRequest<State>(adapter: ProbeAdapter<State>, request: RunRequest): void {
  if (!request || typeof request.caseId !== 'string' || !request.caseId || typeof request.seed !== 'string' || !request.seed) throw new TypeError('caseId and seed are required strings');
  if (!Number.isSafeInteger(request.maxTicks) || request.maxTicks < 0) throw new RangeError('maxTicks must be a non-negative safe integer');
  const d = adapter.descriptor;
  if (!d || d.protocolVersion !== 1 || d.oracleVersion !== 'probe-oracle-v1' || !Number.isFinite(d.tickRate) || d.tickRate <= 0 || !Array.isArray(d.numericPaths) || new Set(d.numericPaths).size !== d.numericPaths.length || d.numericPaths.some((path) => !path.startsWith('/') || path === '/' || /~(?![01])/.test(path))) throw new TypeError('invalid simulation descriptor');
  for (const key of ['adapterId', 'adapterVersion', 'simulationVersion', 'implementationHash', 'buildId', 'stateVersion', 'commandVersion', 'worldVersion', 'configVersion', 'startVersion', 'coordinateSystem', 'units'] as const) if (!d[key]) throw new TypeError(`descriptor.${key} is required`);
}

function deepFreeze<T>(value: T, seen = new Set<object>(), frozenObjects?: WeakSet<object>): T {
  if (!value || typeof value !== 'object' || seen.has(value) || frozenObjects?.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child, seen, frozenObjects);
  }
  Object.freeze(value);
  frozenObjects?.add(value);
  return value;
}

function errorRecord(error: unknown, tick: number): { name: string; message: string; tick: number } {
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), tick };
}

function isFiniteAABB(value: Inspection['actorBounds']): value is NonNullable<Inspection['actorBounds']> {
  if (!value || value.min.some((item) => !Number.isFinite(item)) || value.max.some((item) => !Number.isFinite(item))) return false;
  return value.min.every((item, index) => item <= (value.max[index] ?? Number.NEGATIVE_INFINITY));
}
