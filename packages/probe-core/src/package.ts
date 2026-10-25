import { assertDataDTO, assertFiniteStateDTO, assertStateDTO, canonicalHash, canonicalJson, compareCodePoints, decodeUtf8, getPointer, utf8Bytes, utf8Length } from './canonical.js';
import { validateOracleConfig } from './oracle.js';
import type { CaseResult, CommandStrategy, CompatibilityResult, DataDTO, ImportLimits, ImportResult, OracleConfig, ProbeAdapter, ProbePackage, ReplayOptions, ReplayResult, RunRequest, SimulationDescriptor, StateDTO } from './types.js';
import { createRunController } from './runner.js';
import { TOOL_IDENTITY } from './version.js';

export function createProbePackage<State>(adapter: ProbeAdapter<State>, request: RunRequest, result: CaseResult): ProbePackage {
  validateDescriptor(adapter.descriptor);
  if (request.caseId !== result.caseId || request.seed !== result.seed || !Number.isSafeInteger(request.maxTicks) || request.maxTicks < result.ticksExecuted) throw new TypeError('package request metadata does not match its case result');
  const inputs = result.inputs;
  const initialState = cloneState(validateState(result.initialState, adapter.descriptor, {}, true));
  const commands = result.trace.map((entry) => {
    assertDataDTO(entry.command);
    return cloneData(entry.command);
  });
  const oracle = cloneOracle(adapter.getOracleConfig(adapter.decodeConfig(cloneData(inputs.config))));
  const outcomeStatus = result.failure || result.invalidStart ? 'failed' : result.status === 'complete' ? 'healthy' : 'incomplete';
  const body: Omit<ProbePackage, 'integrity'> = {
    schemaVersion: 1,
    kind: 'probelab-package',
    tool: { ...TOOL_IDENTITY },
    descriptor: cloneData(adapter.descriptor as unknown as DataDTO) as unknown as SimulationDescriptor,
    oracle,
    hashes: { world: inputs.worldHash, config: inputs.configHash },
    coverage: cloneData(result.coverage as unknown as DataDTO) as unknown as ProbePackage['coverage'],
    case: {
      caseId: request.caseId, seed: request.seed, maxTicks: request.maxTicks, dt: 1 / adapter.descriptor.tickRate,
      rngInitial: result.rngInitial, rngFinal: result.rngFinal,
    },
    encoded: {
      world: cloneData(inputs.world), config: cloneData(inputs.config), start: cloneData(inputs.start),
      initialState, debugWorld: cloneData(inputs.debugWorld as unknown as DataDTO) as unknown as ProbePackage['encoded']['debugWorld'], commands,
    },
    outcome: {
      status: outcomeStatus, ticksExecuted: result.ticksExecuted,
      ...(result.failure ? { failure: cloneSpecial(result.failure) } : {}),
      ...(result.invalidStart ? { invalidStart: cloneSpecial(result.invalidStart) } : {}),
      ...(result.error ? { error: cloneData(result.error as unknown as DataDTO) as unknown as ProbePackage['outcome']['error'] } : {}),
      ...(result.cancelReason ? { cancelReason: result.cancelReason } : {}),
      trace: cloneSpecial(result.trace),
    },
  };
  validatePackageBody(body, { maxBytes: Number.MAX_SAFE_INTEGER });
  const contentHash = canonicalHash(body);
  return { ...body, integrity: { algorithm: 'sha256', contentHash } };
}

export function importProbePackage(input: string | Uint8Array, limits: ImportLimits = {}): ImportResult {
  const maxBytes = limits.maxBytes ?? 32 * 1024 * 1024;
  try {
    const inputBytes = typeof input === 'string' ? utf8Length(input) : input.byteLength;
    if (inputBytes > maxBytes) return { ok: false, code: 'IMPORT_SIZE', message: `文件超过 ${maxBytes} 字节限制` };
    const text = typeof input === 'string' ? input : decodeUtf8(input);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'IMPORT_SCHEMA', message: '顶层必须是对象' };
    const pkg = parsed as ProbePackage;
    validatePackageBody(pkg, limits);
    const integrityError = verifyPackageIntegrity(pkg, limits);
    if (integrityError) return { ok: false, code: 'IMPORT_HASH', message: integrityError };
    return { ok: true, value: pkg };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RangeError ? 'IMPORT_LIMIT' : /UTF-8/.test(message) ? 'IMPORT_UTF8' : 'IMPORT_INVALID';
    return { ok: false, code, message };
  }
}

export function checkCompatibility<State>(pkg: ProbePackage, adapter: ProbeAdapter<State>): CompatibilityResult {
  const differences: string[] = [];
  const integrityError = verifyPackageIntegrity(pkg);
  if (integrityError) return { compatible: false, differences: [`package integrity: ${integrityError}`] };
  compareDescriptor(pkg.descriptor, adapter.descriptor, differences);
  return { compatible: differences.length === 0, differences };
}

export function verifyPackageIntegrity(pkg: ProbePackage, limits: ImportLimits = {}): string | undefined {
  try {
    validatePackageBody(pkg, limits);
    if (!pkg.integrity || pkg.integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(pkg.integrity.contentHash)) return 'missing or malformed SHA-256 integrity field';
    assertExactKeys(pkg.integrity, ['algorithm', 'contentHash'], 'integrity');
    const { integrity, ...body } = pkg;
    if (canonicalHash(body) !== integrity.contentHash) return 'content hash mismatch';
    return undefined;
  } catch (error) { return message(error); }
}

export function replayPackage<State>(adapter: ProbeAdapter<State>, pkg: ProbePackage, options: ReplayOptions): ReplayResult {
  const differences: string[] = [];
  const integrityError = verifyPackageIntegrity(pkg);
  if (integrityError) return { compatible: false, status: 'incompatible', ticksExecuted: 0, reason: integrityError, targetDifferences: [] };
  if (options.mode === 'strict') compareDescriptor(pkg.descriptor, adapter.descriptor, differences);
  else compareRegressionSchema(pkg.descriptor, adapter.descriptor, differences);
  if (differences.length) return { compatible: false, status: 'incompatible', ticksExecuted: 0, reason: differences.join('; '), targetDifferences: differences };

  if (options.mode === 'strict') {
    try {
      if (options.targetWorld !== undefined && canonicalHash(adapter.encodeWorld(options.targetWorld)) !== pkg.hashes.world) differences.push(`strict target world differs from package hash ${pkg.hashes.world}`);
      if (options.targetConfig !== undefined && canonicalHash(adapter.encodeConfig(options.targetConfig)) !== pkg.hashes.config) differences.push(`strict target config differs from package hash ${pkg.hashes.config}`);
    } catch (error) { return { compatible: false, status: 'incompatible', ticksExecuted: 0, reason: message(error), targetDifferences: differences }; }
    if (differences.length) return { compatible: false, status: 'incompatible', ticksExecuted: 0, reason: differences.join('; '), targetDifferences: differences };
  }

  let world: unknown; let config: unknown; let start: unknown;
  try {
    const storedWorldHash = canonicalHash(pkg.encoded.world);
    const storedConfigHash = canonicalHash(pkg.encoded.config);
    if (storedWorldHash !== pkg.hashes.world) throw new Error('package world hash mismatch');
    if (storedConfigHash !== pkg.hashes.config) throw new Error('package config hash mismatch');
    world = options.targetWorld !== undefined ? options.targetWorld : adapter.decodeWorld(cloneData(pkg.encoded.world));
    config = options.targetConfig !== undefined ? options.targetConfig : adapter.decodeConfig(cloneData(pkg.encoded.config));
    start = adapter.decodeStart(cloneData(pkg.encoded.start));
    if (canonicalHash(adapter.encodeStart(start)) !== canonicalHash(pkg.encoded.start)) throw new Error('decoded start does not round-trip to packaged start');
    const roundWorld = cloneData(adapter.encodeWorld(world)); assertDataDTO(roundWorld);
    const roundConfig = cloneData(adapter.encodeConfig(config)); assertDataDTO(roundConfig);
    if (options.mode === 'strict' && canonicalHash(roundWorld) !== pkg.hashes.world) throw new Error('decoded world does not round-trip to packaged world hash');
    if (options.mode === 'strict' && canonicalHash(roundConfig) !== pkg.hashes.config) throw new Error('decoded config does not round-trip to packaged config hash');
    if (options.mode === 'strict' && canonicalHash(validateDebugWorld(adapter.toDebugWorld(world), adapter.descriptor)) !== canonicalHash(pkg.encoded.debugWorld)) throw new Error('debug world does not match packaged collision scene');
    if (options.mode === 'regress') {
      for (const key of ['adapterVersion', 'simulationVersion', 'implementationHash', 'buildId', 'worldVersion', 'configVersion'] as const) if (pkg.descriptor[key] !== adapter.descriptor[key]) differences.push(`target descriptor.${key}: ${pkg.descriptor[key]} -> ${adapter.descriptor[key]}`);
      if (canonicalHash(roundWorld) !== pkg.hashes.world) differences.push(`world hash ${pkg.hashes.world} -> ${canonicalHash(roundWorld)}`);
      if (canonicalHash(roundConfig) !== pkg.hashes.config) differences.push(`config hash ${pkg.hashes.config} -> ${canonicalHash(roundConfig)}`);
    }
    const targetOracle = cloneOracle(adapter.getOracleConfig(config));
    if (options.mode === 'strict' && canonicalHash(targetOracle) !== canonicalHash(pkg.oracle)) throw new Error('oracle config differs from package manifest');
    if (options.mode === 'regress' && canonicalHash(targetOracle) !== canonicalHash(pkg.oracle)) differences.push(`oracle config ${canonicalHash(pkg.oracle)} -> ${canonicalHash(targetOracle)}`);
    const targetInitial = adapter.createInitialState(world, config, start);
    const targetInitialDTO = adapter.encodeState(targetInitial);
    assertStateDTO(targetInitialDTO, adapter.descriptor);
    if (canonicalHash(targetInitialDTO) !== canonicalHash(pkg.encoded.initialState)) throw new Error('initial state differs from package; implicit migration is forbidden');
  } catch (error) {
    return { compatible: false, status: 'incompatible', ticksExecuted: 0, reason: message(error), targetDifferences: differences };
  }

  const worldForRun = world; const configForRun = config; const startForRun = start;
  const request: RunRequest = { caseId: pkg.case.caseId, seed: pkg.case.seed, world: worldForRun, config: configForRun, start: startForRun, maxTicks: pkg.encoded.commands.length };
  const commandStrategy: CommandStrategy<State> = {
    nextCommand(context) {
      const data = pkg.encoded.commands[context.tick - 1];
      if (data === undefined) throw new Error(`recorded command missing at tick ${context.tick}`);
      return adapter.decodeCommand(cloneData(data));
    },
  };
  let result;
  try {
    const controller = createRunController(adapter, request, commandStrategy);
    result = controller.advance(pkg.encoded.commands.length);
    if (pkg.outcome.status === 'incomplete' && result.status === 'complete' && result.ticksExecuted < pkg.case.maxTicks) {
      return { compatible: true, status: 'incomplete', ticksExecuted: result.ticksExecuted, reason: '仅重放了已记录的命令前缀', result, targetDifferences: differences };
    }
  } catch (error) {
    return { compatible: false, status: 'error', ticksExecuted: 0, reason: message(error), targetDifferences: differences };
  }

  const expectedTrace = pkg.outcome.trace;
  const traceCount = Math.min(result.trace.length, expectedTrace.length);
  for (let index = 0; index < traceCount; index++) {
    const expected = expectedTrace[index]; const actual = result.trace[index];
    if (!expected || !actual || expected.tick !== actual.tick || canonicalHash(expected.command) !== canonicalHash(actual.command) || (options.mode === 'strict' && expected.stateHash !== actual.stateHash)) {
      return { compatible: true, status: 'diverged', ticksExecuted: result.ticksExecuted, firstDivergentTick: (expected?.tick ?? actual?.tick ?? index + 1), reason: options.mode === 'strict' ? '首个逐 tick 命令或完整状态摘要不一致' : '回归命令序列与原记录不一致', result, targetDifferences: differences };
    }
  }
  if (result.trace.length !== expectedTrace.length) return { compatible: true, status: 'diverged', ticksExecuted: result.ticksExecuted, firstDivergentTick: traceCount + 1, reason: '轨迹 tick 数不一致', result, targetDifferences: differences };

  if (options.mode === 'strict') {
    if (pkg.outcome.status === 'failed') {
      const actualFailure = result.failure ?? result.invalidStart;
      const expectedFailure = pkg.outcome.failure ?? pkg.outcome.invalidStart;
      if (!actualFailure || !expectedFailure || canonicalHash(actualFailure.signature) !== canonicalHash(expectedFailure.signature) || actualFailure.tick !== expectedFailure.tick) {
        return { compatible: true, status: 'diverged', ticksExecuted: result.ticksExecuted, firstDivergentTick: expectedFailure?.tick ?? 0, reason: '首故障签名或 tick 不一致', result, targetDifferences: differences };
      }
      return { compatible: true, status: 'verified-failure', ticksExecuted: result.ticksExecuted, result, targetDifferences: differences };
    }
    if (pkg.outcome.status === 'incomplete') return { compatible: true, status: 'incomplete', ticksExecuted: result.ticksExecuted, reason: '原始运行在预算或取消处结束', result, targetDifferences: differences };
  }
  if (result.failure || result.invalidStart || result.error) return { compatible: true, status: 'diverged', ticksExecuted: result.ticksExecuted, firstDivergentTick: result.failure?.tick ?? result.invalidStart?.tick ?? result.error?.tick ?? 0, reason: '健康回归在目标版本中产生了故障或运行错误', result, targetDifferences: differences };
  return { compatible: true, status: 'healthy', ticksExecuted: result.ticksExecuted, result, targetDifferences: differences };
}

export function runCommands<State>(adapter: ProbeAdapter<State>, pkg: ProbePackage, commands: DataDTO[], maxTicks = commands.length): CaseResult {
  const world = adapter.decodeWorld(cloneData(pkg.encoded.world));
  const config = adapter.decodeConfig(cloneData(pkg.encoded.config));
  const start = adapter.decodeStart(cloneData(pkg.encoded.start));
  const request: RunRequest = { caseId: pkg.case.caseId, seed: pkg.case.seed, world, config, start, maxTicks };
  let index = 0;
  const strategy: CommandStrategy<State> = { nextCommand() { const command = commands[index++]; if (command === undefined) throw new Error('candidate command unexpectedly missing'); return adapter.decodeCommand(cloneData(command)); } };
  return createRunController(adapter, request, strategy).advance(maxTicks);
}

function validatePackageBody(pkg: Omit<ProbePackage, 'integrity'> | ProbePackage, limits: ImportLimits): void {
  const maxDepth = limits.maxDepth ?? 96; const maxNodes = limits.maxNodes ?? 1_000_000;
  assertExactKeys(pkg, ['schemaVersion', 'kind', 'tool', 'descriptor', 'oracle', 'hashes', 'coverage', 'case', 'encoded', 'outcome', ...(Object.prototype.hasOwnProperty.call(pkg, 'integrity') ? ['integrity'] : [])], 'package');
  if (pkg.schemaVersion !== 1 || pkg.kind !== 'probelab-package') throw new TypeError('unsupported package schema or kind');
  assertExactKeys(pkg.tool, ['name', 'version'], 'tool');
  if (pkg.tool.name !== TOOL_IDENTITY.name || pkg.tool.version !== TOOL_IDENTITY.version) throw new TypeError('unsupported ProbeLab tool version');
  validateDescriptor(pkg.descriptor);
  assertExactKeys(pkg.oracle, ['boundsMode', 'enabledAxes', 'tolerance', 'penetrationEpsilon'], 'oracle');
  validateOracleConfig(pkg.oracle);
  if (canonicalHash(cloneOracle(pkg.oracle)) !== canonicalHash(pkg.oracle)) throw new TypeError('oracle axes must use canonical x/y/z order');
  assertExactKeys(pkg.hashes, ['world', 'config'], 'hashes');
  assertDataDTO(pkg.hashes, { maxDepth, maxNodes });
  if (!/^[a-f0-9]{64}$/.test(pkg.hashes.world) || !/^[a-f0-9]{64}$/.test(pkg.hashes.config)) throw new TypeError('world/config hash must be SHA-256 hex');
  assertExactKeys(pkg.coverage, ['visits', 'visited', ...['capacity', 'ratio'].filter((key) => Object.prototype.hasOwnProperty.call(pkg.coverage, key))], 'coverage');
  assertDataDTO(pkg.coverage, { maxDepth, maxNodes });
  if (!Number.isSafeInteger(pkg.coverage.visited) || pkg.coverage.visited < 0 || (pkg.coverage.capacity !== undefined && (!Number.isSafeInteger(pkg.coverage.capacity) || pkg.coverage.capacity < 1)) || (pkg.coverage.ratio !== undefined && (!Number.isFinite(pkg.coverage.ratio) || pkg.coverage.ratio < 0 || pkg.coverage.ratio > 1))) throw new TypeError('invalid coverage summary');
  if (!pkg.coverage.visits || typeof pkg.coverage.visits !== 'object' || Array.isArray(pkg.coverage.visits) || Object.keys(pkg.coverage.visits).length !== pkg.coverage.visited || Object.values(pkg.coverage.visits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('coverage visit counts do not match visited count');
  if (pkg.coverage.capacity === undefined && pkg.coverage.ratio !== undefined) throw new TypeError('coverage ratio requires a known capacity');
  if (pkg.coverage.capacity !== undefined && pkg.coverage.ratio !== undefined && Math.abs(pkg.coverage.ratio - Math.min(1, pkg.coverage.visited / pkg.coverage.capacity)) > Number.EPSILON) throw new TypeError('coverage ratio is inconsistent');
  assertExactKeys(pkg.case, ['caseId', 'seed', 'maxTicks', 'dt', 'rngInitial', 'rngFinal'], 'case');
  if (!pkg.case.caseId || !pkg.case.seed || !Number.isSafeInteger(pkg.case.maxTicks) || pkg.case.maxTicks < 0 || !Number.isFinite(pkg.case.dt) || pkg.case.dt <= 0 || Math.abs(pkg.case.dt - 1 / pkg.descriptor.tickRate) > Number.EPSILON) throw new TypeError('invalid package case metadata');
  validateRng(pkg.case.rngInitial); validateRng(pkg.case.rngFinal);
  if (pkg.outcome.ticksExecuted > pkg.case.maxTicks) throw new TypeError('executed ticks exceed case budget');
  assertExactKeys(pkg.encoded, ['world', 'config', 'start', 'initialState', 'debugWorld', 'commands'], 'encoded');
  assertDataDTO(pkg.encoded.world, { maxDepth, maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength });
  assertDataDTO(pkg.encoded.config, { maxDepth, maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength });
  assertDataDTO(pkg.encoded.start, { maxDepth, maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength });
  if (canonicalHash(pkg.encoded.world) !== pkg.hashes.world || canonicalHash(pkg.encoded.config) !== pkg.hashes.config) throw new TypeError('normalized world/config hash does not match encoded input');
  validateState(pkg.encoded.initialState, pkg.descriptor, limits, true);
  const normalizedDebugWorld = validateDebugWorld(pkg.encoded.debugWorld, pkg.descriptor);
  if (canonicalHash(normalizedDebugWorld) !== canonicalHash(pkg.encoded.debugWorld)) throw new TypeError('DebugWorld colliders and labels must use canonical stable-ID order');
  if (!Array.isArray(pkg.encoded.commands)) throw new TypeError('commands must be an array');
  const maxCommands = limits.maxCommands ?? 3600;
  if (pkg.encoded.commands.length > maxCommands) throw new RangeError('command count limit exceeded');
  for (const command of pkg.encoded.commands) assertDataDTO(command, { maxDepth, maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength });
  assertExactKeys(pkg.outcome, ['status', 'ticksExecuted', 'trace', ...['failure', 'invalidStart', 'error', 'cancelReason'].filter((key) => Object.prototype.hasOwnProperty.call(pkg.outcome, key))], 'outcome');
  if (!['failed', 'healthy', 'incomplete'].includes(pkg.outcome.status) || !Number.isSafeInteger(pkg.outcome.ticksExecuted) || pkg.outcome.ticksExecuted < 0) throw new TypeError('invalid outcome');
  if (!Array.isArray(pkg.outcome.trace)) throw new TypeError('trace must be an array');
  const maxTraceTicks = limits.maxTraceTicks ?? 3600;
  if (pkg.outcome.trace.length > maxTraceTicks) throw new RangeError('trace tick limit exceeded');
  if (pkg.outcome.trace.length !== pkg.outcome.ticksExecuted || pkg.outcome.trace.length !== pkg.encoded.commands.length) throw new TypeError('command/trace/tick counts disagree');
  for (let index = 0; index < pkg.outcome.trace.length; index++) {
    const tick = pkg.outcome.trace[index];
    if (!tick) throw new TypeError(`missing trace tick ${index + 1}`);
    assertExactKeys(tick, ['tick', 'command', 'state', 'stateHash', ...['position', 'actorBounds', 'detail'].filter((key) => Object.prototype.hasOwnProperty.call(tick, key))], `trace[${index}]`);
    if (tick.tick !== index + 1 || !/^[a-f0-9]{64}$/.test(tick.stateHash) || canonicalHash(tick.state) !== tick.stateHash || canonicalHash(tick.command) !== canonicalHash(pkg.encoded.commands[index])) throw new TypeError(`invalid tick summary ${index + 1}`);
    validateState(tick.state, pkg.descriptor, limits);
    if (tick.position) assertFiniteVector(tick.position, `trace[${index}].position`);
    if (tick.actorBounds) validateAABB(tick.actorBounds, `trace[${index}].actorBounds`);
    if (tick.detail !== undefined) assertDataDTO(tick.detail, { maxDepth, maxNodes });
  }
  if (pkg.outcome.failure) {
    assertExactKeys(pkg.outcome.failure, ['kind', 'tick', 'signature', 'detail', 'state'], 'failure');
    if (!['non-finite-state', 'out-of-bounds', 'penetration'].includes(pkg.outcome.failure.kind) || !Number.isSafeInteger(pkg.outcome.failure.tick) || pkg.outcome.failure.tick < 1 || pkg.outcome.failure.tick !== pkg.outcome.trace.length) throw new TypeError('failure must be the final recorded first-fault tick');
    validateFailure(pkg.outcome.failure, pkg.descriptor, limits);
    const traceState = pkg.outcome.trace[pkg.outcome.failure.tick - 1]?.state;
    if (canonicalHash(traceState) !== canonicalHash(pkg.outcome.failure.state)) throw new TypeError('failure state must equal first fault tick state');
  }
  if (pkg.outcome.invalidStart) {
    assertExactKeys(pkg.outcome.invalidStart, ['kind', 'tick', 'signature', 'detail', 'state'], 'invalidStart');
    if (pkg.outcome.invalidStart.kind !== 'invalid-start' || pkg.outcome.invalidStart.tick !== 0) throw new TypeError('invalid invalid-start record');
    assertExactKeys(pkg.outcome.invalidStart.signature, ['kind', 'target'], 'invalidStart.signature');
    if (pkg.outcome.invalidStart.signature.kind !== 'invalid-start' || !pkg.outcome.invalidStart.signature.target) throw new TypeError('invalid invalid-start signature');
    validateState(pkg.outcome.invalidStart.state, pkg.descriptor, limits);
    assertDataDTO(pkg.outcome.invalidStart.detail, { maxDepth, maxNodes });
    if (canonicalHash(pkg.outcome.invalidStart.state) !== canonicalHash(pkg.encoded.initialState)) throw new TypeError('invalid-start state must equal initial state');
    if (pkg.outcome.trace.length !== 0) throw new TypeError('invalid start cannot contain simulation ticks');
  }
  if (pkg.outcome.error) {
    assertExactKeys(pkg.outcome.error, ['name', 'message', 'tick'], 'error');
    if (typeof pkg.outcome.error.name !== 'string' || pkg.outcome.error.name.length > 128 || typeof pkg.outcome.error.message !== 'string' || pkg.outcome.error.message.length > 10_000 || !Number.isSafeInteger(pkg.outcome.error.tick) || pkg.outcome.error.tick < 0 || pkg.outcome.error.tick > pkg.case.maxTicks) throw new TypeError('invalid simulation error');
  }
  if (pkg.outcome.cancelReason !== undefined && typeof pkg.outcome.cancelReason !== 'string') throw new TypeError('invalid cancel reason');
  if (pkg.outcome.failure && pkg.outcome.invalidStart) throw new TypeError('package cannot contain both a motion failure and invalid start');
  if (pkg.outcome.status === 'failed' && !pkg.outcome.failure && !pkg.outcome.invalidStart) throw new TypeError('failed package must carry a first failure or invalid start');
  if (pkg.outcome.status === 'failed' && pkg.outcome.error) throw new TypeError('simulation errors are not deterministic failures');
  if (pkg.outcome.status === 'incomplete' && (pkg.outcome.failure || pkg.outcome.invalidStart)) throw new TypeError('a completed first failure must use failed status');
  if (pkg.outcome.status === 'healthy' && (pkg.outcome.failure || pkg.outcome.invalidStart || pkg.outcome.error || pkg.outcome.ticksExecuted !== pkg.case.maxTicks)) throw new TypeError('healthy package must complete its tick budget without failure or error');
  if (pkg.outcome.status !== 'incomplete' && (pkg.outcome.error || pkg.outcome.cancelReason)) throw new TypeError('run errors and cancellation reasons require incomplete status');
  const byteLimit = limits.maxBytes;
  if (byteLimit !== undefined && utf8Bytes(canonicalJson(pkg)).byteLength > byteLimit) throw new RangeError('canonical package byte limit exceeded');
}

function validateDescriptor(descriptor: SimulationDescriptor): void {
  assertExactKeys(descriptor, ['protocolVersion', 'adapterId', 'adapterVersion', 'simulationVersion', 'implementationHash', 'buildId', 'stateVersion', 'commandVersion', 'worldVersion', 'configVersion', 'startVersion', 'tickRate', 'coordinateSystem', 'units', 'numericPaths', 'oracleVersion'], 'descriptor');
  if (!descriptor || descriptor.protocolVersion !== 1 || descriptor.oracleVersion !== 'probe-oracle-v1' || !Number.isFinite(descriptor.tickRate) || descriptor.tickRate <= 0) throw new TypeError('unsupported or invalid simulation descriptor');
  for (const key of ['adapterId', 'adapterVersion', 'simulationVersion', 'implementationHash', 'buildId', 'stateVersion', 'commandVersion', 'worldVersion', 'configVersion', 'startVersion', 'coordinateSystem', 'units'] as const) if (typeof descriptor[key] !== 'string' || descriptor[key].length === 0) throw new TypeError(`descriptor.${key} is required`);
  if (!Array.isArray(descriptor.numericPaths) || descriptor.numericPaths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.length > 512 || /~(?![01])/.test(path)) || new Set(descriptor.numericPaths).size !== descriptor.numericPaths.length) throw new TypeError('invalid numericPaths');
}

function validateState(state: StateDTO, descriptor: SimulationDescriptor, limits: ImportLimits = {}, finiteOnly = false): StateDTO {
  if (finiteOnly) assertFiniteStateDTO(state, descriptor, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength, maxBytes: limits.maxBytes });
  else assertStateDTO(state, descriptor, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxArrayLength: limits.maxArrayLength, maxStringLength: limits.maxStringLength, maxBytes: limits.maxBytes });
  return state;
}
function cloneState(value: StateDTO): StateDTO { return JSON.parse(canonicalJson(value)) as StateDTO; }
function cloneSpecial<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }

function validateDebugWorld(world: ProbePackage['encoded']['debugWorld'], descriptor: SimulationDescriptor): ProbePackage['encoded']['debugWorld'] {
  assertDataDTO(world as unknown as DataDTO);
  assertExactKeys(world, ['mapId', 'coordinateSystem', 'units', 'colliders', ...['bounds', 'labels', 'metadata'].filter((key) => Object.prototype.hasOwnProperty.call(world, key))], 'debugWorld');
  if (!world || typeof world.mapId !== 'string' || !world.mapId || world.coordinateSystem !== descriptor.coordinateSystem || world.units !== descriptor.units || !Array.isArray(world.colliders)) throw new TypeError('invalid DebugWorld');
  if (world.bounds) validateAABB(world.bounds, 'debugWorld.bounds');
  const ids = new Set<string>();
  for (const collider of world.colliders) {
    assertExactKeys(collider, ['id', 'bounds', 'solid'], 'debugWorld.collider');
    if (!collider || typeof collider.id !== 'string' || !collider.id || ids.has(collider.id) || typeof collider.solid !== 'boolean') throw new TypeError('DebugWorld collider IDs must be unique and valid');
    ids.add(collider.id); validateAABB(collider.bounds, `debugWorld.collider.${collider.id}`);
  }
  for (const label of world.labels ?? []) { assertExactKeys(label, ['id', 'label', 'position'], 'debugWorld.label'); if (!label.id || !label.label) throw new TypeError('invalid DebugWorld label'); assertFiniteVector(label.position, `debugWorld.label.${label.id}`); }
  return { ...world, colliders: [...world.colliders].sort((a, b) => compareCodePoints(a.id, b.id)), ...(world.labels ? { labels: [...world.labels].sort((a, b) => compareCodePoints(a.id, b.id)) } : {}) };
}

function validateFailure(failure: NonNullable<ProbePackage['outcome']['failure']>, descriptor: SimulationDescriptor, limits: ImportLimits): void {
  assertExactKeys(failure.signature, ['kind', 'target'], 'failure.signature');
  if (failure.signature.kind !== failure.kind || typeof failure.signature.target !== 'string' || !failure.signature.target) throw new TypeError('invalid failure signature');
  validateState(failure.state, descriptor, limits); assertDataDTO(failure.detail, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes });
  if (failure.kind === 'non-finite-state') {
    assertExactKeys(failure.detail, ['rule', 'path', 'numberType'], 'non-finite detail');
    const detail = failure.detail as Record<string, DataDTO>;
    const path = detail.path; const numberType = detail.numberType;
    if (detail.rule !== 'non-finite-state' || typeof path !== 'string' || typeof numberType !== 'string' || !['NaN', '+Infinity', '-Infinity'].includes(numberType) || failure.signature.target !== `${path}:${numberType}`) throw new TypeError('non-finite failure target/detail mismatch');
    const stored = getPointer(failure.state, path);
    if (!stored || typeof stored !== 'object' || (stored as { $probeNumber?: unknown }).$probeNumber !== numberType) throw new TypeError('non-finite failure state does not contain its tagged value');
    const firstNonFinite = [...descriptor.numericPaths].filter((candidate) => { const value = getPointer(failure.state, candidate); return !!value && typeof value === 'object' && '$probeNumber' in value; }).sort(compareCodePoints)[0];
    if (firstNonFinite !== path) throw new TypeError('non-finite failure must name the first sorted non-finite field');
  } else if (failure.kind === 'out-of-bounds') {
    assertFiniteNumericFields(failure.state, descriptor);
    assertExactKeys(failure.detail, ['axis', 'direction', 'boundary', 'value', 'tolerance'], 'out-of-bounds detail');
    const detail = failure.detail as Record<string, DataDTO>;
    const axis = detail.axis; const direction = detail.direction; const boundary = detail.boundary; const value = detail.value; const tolerance = detail.tolerance;
    if (!['x', 'y', 'z'].includes(String(axis)) || !['negative', 'positive'].includes(String(direction)) || failure.signature.target !== `${axis}:${direction}` || typeof boundary !== 'number' || typeof value !== 'number' || typeof tolerance !== 'number' || !Number.isFinite(boundary) || !Number.isFinite(value) || !Number.isFinite(tolerance) || tolerance < 0 || (direction === 'negative' && !(value < boundary - tolerance)) || (direction === 'positive' && !(value > boundary + tolerance))) throw new TypeError('out-of-bounds failure target/detail mismatch');
  } else {
    assertFiniteNumericFields(failure.state, descriptor);
    assertExactKeys(failure.detail, ['colliderId', 'axisDepths', 'depth', 'epsilon'], 'penetration detail');
    const detail = failure.detail as Record<string, DataDTO>;
    const colliderId = detail.colliderId; const axisDepths = detail.axisDepths; const depth = detail.depth; const epsilon = detail.epsilon;
    if (typeof colliderId !== 'string' || !colliderId || failure.signature.target !== colliderId || !Array.isArray(axisDepths) || axisDepths.length !== 3 || axisDepths.some((item) => typeof item !== 'number' || !Number.isFinite(item)) || typeof depth !== 'number' || !Number.isFinite(depth) || depth !== Math.min(...axisDepths as number[]) || typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0 || axisDepths.some((item) => (item as number) <= epsilon)) throw new TypeError('penetration failure target/detail mismatch');
  }
}

function assertFiniteNumericFields(state: StateDTO, descriptor: SimulationDescriptor): void {
  for (const path of descriptor.numericPaths) {
    const value = getPointer(state, path);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`failure state for geometric oracle contains non-finite field ${path}`);
  }
}

function validateAABB(bounds: { min: number[]; max: number[] }, where: string): void {
  assertExactKeys(bounds, ['min', 'max'], where);
  assertFiniteVector(bounds.min, `${where}.min`); assertFiniteVector(bounds.max, `${where}.max`);
  if (bounds.min.some((value, index) => value > (bounds.max[index] ?? Number.NEGATIVE_INFINITY))) throw new TypeError(`${where} min exceeds max`);
}
function assertFiniteVector(value: number[], where: string): void { if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) throw new TypeError(`${where} must be a finite 3-vector`); }
function validateRng(value: ProbePackage['case']['rngInitial']): void {
  assertExactKeys(value, ['algorithm', 'state'], 'rng state');
  if (!value || value.algorithm !== 'xoshiro128ss-v1' || !Array.isArray(value.state) || value.state.length !== 4 || value.state.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff_ffff) || value.state.every((part) => part === 0)) throw new TypeError('invalid PRNG state');
}
function compareDescriptor(left: SimulationDescriptor, right: SimulationDescriptor, differences: string[]): void {
  for (const key of ['protocolVersion', 'adapterId', 'adapterVersion', 'simulationVersion', 'implementationHash', 'buildId', 'stateVersion', 'commandVersion', 'worldVersion', 'configVersion', 'startVersion', 'tickRate', 'coordinateSystem', 'units', 'oracleVersion'] as const) if (left[key] !== right[key]) differences.push(`descriptor.${key}: ${String(left[key])} -> ${String(right[key])}`);
  if (canonicalHash(left.numericPaths) !== canonicalHash(right.numericPaths)) differences.push('descriptor.numericPaths differ');
}
function compareRegressionSchema(left: SimulationDescriptor, right: SimulationDescriptor, differences: string[]): void {
  for (const key of ['protocolVersion', 'adapterId', 'stateVersion', 'commandVersion', 'startVersion', 'tickRate', 'coordinateSystem', 'units', 'oracleVersion'] as const) if (left[key] !== right[key]) differences.push(`incompatible descriptor.${key}`);
  if (canonicalHash(left.numericPaths) !== canonicalHash(right.numericPaths)) differences.push('incompatible descriptor.numericPaths');
}
function cloneOracle(value: OracleConfig): OracleConfig { validateOracleConfig(value); const order = ['x', 'y', 'z']; return { boundsMode: value.boundsMode, enabledAxes: [...value.enabledAxes].sort((a, b) => order.indexOf(a) - order.indexOf(b)), tolerance: [...value.tolerance] as [number, number, number], penetrationEpsilon: value.penetrationEpsilon }; }
function cloneData<T extends DataDTO>(value: T): T { assertDataDTO(value); return JSON.parse(canonicalJson(value)) as T; }
function assertExactKeys(value: unknown, required: string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has missing or unknown fields`);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
