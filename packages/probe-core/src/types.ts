/** JSON-compatible, finite, data-only value. No functions, prototypes, cycles, or undefined. */
export type DataDTO = null | boolean | string | number | DataDTO[] | { [key: string]: DataDTO };

/** Special numbers are permitted only in serialized state snapshots at descriptor.numericPaths. */
export type SpecialNumber = { readonly $probeNumber: 'NaN' | '+Infinity' | '-Infinity' };
export type StateDTO = null | boolean | string | number | SpecialNumber | StateDTO[] | { [key: string]: StateDTO };

export interface SimulationDescriptor {
  protocolVersion: 1;
  adapterId: string;
  adapterVersion: string;
  simulationVersion: string;
  implementationHash: string;
  buildId: string;
  stateVersion: string;
  commandVersion: string;
  worldVersion: string;
  configVersion: string;
  startVersion: string;
  tickRate: number;
  coordinateSystem: string;
  units: string;
  /** JSON-pointer paths containing required numeric state fields. */
  numericPaths: string[];
  /** Stable ordering contract for the built-in first-failure oracle. */
  oracleVersion: 'probe-oracle-v1';
}

export interface OracleConfig {
  boundsMode: 'position' | 'actor';
  enabledAxes: Array<'x' | 'y' | 'z'>;
  tolerance: [number, number, number];
  penetrationEpsilon: number;
}

export interface AABB { min: [number, number, number]; max: [number, number, number] }
export interface NumericField { path: string; value: number }
export interface Collider { id: string; bounds: AABB; solid: boolean }
export interface DebugWorld {
  mapId: string;
  coordinateSystem: string;
  units: string;
  bounds?: AABB;
  colliders: Collider[];
  labels?: Array<{ id: string; label: string; position: [number, number, number] }>;
  metadata?: DataDTO;
}
export interface Inspection {
  /** All descriptor numericPaths must be present here, even if non-finite. */
  numericFields: NumericField[];
  /** Optional geometry; needed for bounds and penetration rules. */
  position?: [number, number, number];
  actorBounds?: AABB;
  worldBounds?: AABB;
  /** Stable-ID sorted by the core before collision checks. */
  colliders?: Collider[];
}

export interface StepObservation<State> { state: State; detail?: DataDTO }
export interface ProbeAdapter<State = unknown> {
  readonly descriptor: SimulationDescriptor;
  encodeWorld(world: unknown): DataDTO;
  decodeWorld(data: DataDTO): unknown;
  encodeConfig(config: unknown): DataDTO;
  decodeConfig(data: DataDTO): unknown;
  encodeStart(start: unknown): DataDTO;
  decodeStart(data: DataDTO): unknown;
  encodeState(state: State): StateDTO;
  decodeState(data: StateDTO): State;
  encodeCommand(command: unknown): DataDTO;
  decodeCommand(data: DataDTO): unknown;
  /** Minimal collision/debug geometry for a viewer with no game assets loaded. */
  toDebugWorld(world: unknown): DebugWorld;
  /** Reads explicit per-scenario thresholds (for example config.oracle); no hidden core defaults. */
  getOracleConfig(config: unknown): OracleConfig;
  /** Optional known universe size for a meaningful visited-cell ratio. */
  coverageCapacity?(world: unknown, config: unknown, start: unknown): number;
  createInitialState(world: unknown, config: unknown, start: unknown): State;
  cloneState(state: State): State;
  /** Pure fixed-dt step: must not mutate state, command, world, or config. */
  step(state: State, command: unknown, world: unknown, config: unknown, dt: number): StepObservation<State>;
  inspect(state: State, world: unknown, config: unknown): Inspection;
  /** Optional adapter-specific start validity. Core AABB checks still run when geometry is supplied. */
  validateStart?(state: State, world: unknown, config: unknown): { valid: boolean; reason?: string };
}

export type FailureKind = 'non-finite-state' | 'out-of-bounds' | 'penetration' | 'invalid-start';
export interface FailureSignature {
  kind: FailureKind;
  target: string;
}
export interface Failure {
  kind: FailureKind;
  tick: number;
  signature: FailureSignature;
  detail: DataDTO;
  state: StateDTO;
}
export interface TickSummary {
  tick: number;
  command: DataDTO;
  state: StateDTO;
  stateHash: string;
  position?: [number, number, number];
  actorBounds?: AABB;
  detail?: DataDTO;
}
export interface InvalidStartRecord {
  kind: 'invalid-start';
  tick: 0;
  signature: FailureSignature;
  detail: DataDTO;
  state: StateDTO;
}
export type RunStatus = 'running' | 'paused' | 'cancelled' | 'complete' | 'failed';
export interface CaseResult {
  caseId: string;
  seed: string;
  rngInitial: { algorithm: 'xoshiro128ss-v1'; state: [number, number, number, number] };
  rngFinal: { algorithm: 'xoshiro128ss-v1'; state: [number, number, number, number] };
  initialState: StateDTO;
  inputs: { world: DataDTO; config: DataDTO; start: DataDTO; debugWorld: DebugWorld; worldHash: string; configHash: string };
  coverage: { visits: Record<string, number>; visited: number; capacity?: number; ratio?: number };
  status: RunStatus;
  ticksExecuted: number;
  trace: TickSummary[];
  failure?: Failure;
  invalidStart?: InvalidStartRecord;
  error?: { name: string; message: string; tick: number };
  cancelReason?: string;
}

export interface RandomSource {
  nextUint32(): number;
  nextFloat(): number;
  snapshot(): { algorithm: 'xoshiro128ss-v1'; state: [number, number, number, number] };
}
export interface CoverageSnapshot { visits: Readonly<Record<string, number>>; total: number; visited: number; capacity?: number; ratio?: number }
export interface StrategyContext<State> {
  caseId: string;
  tick: number;
  seed: string;
  rng: RandomSource;
  state: State;
  inspection: Inspection;
  coverage: CoverageSnapshot;
  previousCommand?: DataDTO;
}
export interface CommandStrategy<State = unknown> {
  /** Called once per tick; must be deterministic for the provided RNG/context. */
  nextCommand(context: StrategyContext<State>): unknown;
  /** Optional coverage key; the core increments it after each successful tick. */
  coverageKey?(inspection: Inspection): string | undefined;
  /** Optional neutral input used by the real replacement phase of minimization. */
  neutralCommand?(context: { index: number; original: DataDTO }): unknown;
  /** Rebuilds tick indices/button edges after a deletion or neutral replacement. */
  normalizeCommands?(commands: readonly DataDTO[]): DataDTO[];
}

export interface RunRequest {
  caseId: string;
  seed: string;
  world: unknown;
  config: unknown;
  start: unknown;
  maxTicks: number;
}
export interface RunController<State = unknown> {
  readonly result: CaseResult;
  readonly currentState: State;
  advance(maxTicks: number): CaseResult;
  pause(): CaseResult;
  resume(): CaseResult;
  cancel(reason?: string): CaseResult;
}

export interface ProbePackage {
  schemaVersion: 1;
  kind: 'probelab-package';
  tool: { name: 'ProbeLab'; version: '0.1.0' };
  descriptor: SimulationDescriptor;
  oracle: OracleConfig;
  hashes: { world: string; config: string };
  coverage: { visits: Record<string, number>; visited: number; capacity?: number; ratio?: number };
  case: { caseId: string; seed: string; maxTicks: number; dt: number; rngInitial: { algorithm: 'xoshiro128ss-v1'; state: [number, number, number, number] }; rngFinal: { algorithm: 'xoshiro128ss-v1'; state: [number, number, number, number] } };
  encoded: { world: DataDTO; config: DataDTO; start: DataDTO; initialState: StateDTO; debugWorld: DebugWorld; commands: DataDTO[] };
  outcome: { status: 'failed' | 'healthy' | 'incomplete'; ticksExecuted: number; failure?: Failure; invalidStart?: InvalidStartRecord; error?: { name: string; message: string; tick: number }; cancelReason?: string; trace: TickSummary[] };
  integrity: { algorithm: 'sha256'; contentHash: string };
}
export interface ImportLimits { maxBytes?: number; maxDepth?: number; maxNodes?: number; maxArrayLength?: number; maxStringLength?: number; maxCommands?: number; maxTraceTicks?: number }
export type ImportResult = { ok: true; value: ProbePackage } | { ok: false; code: string; message: string };
export interface CompatibilityResult { compatible: boolean; differences: string[] }
export type ReplayMode = 'strict' | 'regress';
export interface ReplayOptions { mode: ReplayMode; targetWorld?: unknown; targetConfig?: unknown }
export interface ReplayResult {
  compatible: boolean;
  status: 'verified-failure' | 'healthy' | 'incomplete' | 'diverged' | 'incompatible' | 'error';
  ticksExecuted: number;
  firstDivergentTick?: number;
  reason?: string;
  result?: CaseResult;
  targetDifferences: string[];
}
export interface MinimizeBudget { maxRuns: number; maxTicks: number; maxMilliseconds: number; clock?: () => number; isCancelled?: () => boolean; yieldControl?: () => Promise<void> }
export interface MinimizeResult {
  status: 'reduced' | 'unchanged' | 'budget-exhausted' | 'cancelled' | 'not-reproducible';
  originalLength: number;
  reducedLength: number;
  attempts: number;
  replayVerifications: number;
  elapsedMilliseconds: number;
  stopReason: string;
  package?: ProbePackage;
}
