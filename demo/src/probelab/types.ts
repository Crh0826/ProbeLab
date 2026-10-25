import type {
  CaseResult,
  CommandStrategy,
  DebugWorld,
  MinimizeResult,
  ProbeAdapter,
  ProbePackage,
  ReplayResult,
  RunRequest,
} from '@probelab/core';

export const MAX_PROBE_TICKS = 3_600;

export type ProbeScenarioId = 'healthy' | 'drop' | 'penetration' | 'non-finite';

export interface ScenarioOptions {
  seed: string;
  map?: string;
  scenario?: ProbeScenarioId;
  caseIndex?: number;
}

export interface ProbeScenario<State = unknown> {
  world: unknown;
  config: unknown;
  start: unknown;
  strategy: CommandStrategy<State>;
  maxTicks?: number;
  label?: string;
}

/** Structural host contract; the viewer never imports game code or CLI implementation. */
export interface ProbeTarget<State = unknown> {
  id: string;
  name: string;
  adapter: ProbeAdapter<State>;
  createScenario(options: ScenarioOptions): ProbeScenario<State>;
}

export interface WorkerCaseRequest {
  type: 'run';
  targetId: string;
  map?: string;
  scenario: ProbeScenarioId;
  caseIndex: number;
  caseId: string;
  seed: string;
  maxTicks: number;
  initialPaused?: boolean;
}

export type RunnerWorkerCommand =
  | WorkerCaseRequest
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export interface RunnerProgressMessage {
  type: 'progress';
  caseId: string;
  result: CaseProgress;
  traceDelta: CaseResult['trace'];
  debugWorld?: DebugWorld;
}

export interface RunnerCompleteMessage {
  type: 'complete';
  caseId: string;
  result: CaseResult;
  debugWorld?: DebugWorld;
  package?: ProbePackage;
  error?: string;
}

export interface RunnerErrorMessage {
  type: 'error';
  caseId?: string;
  message: string;
}

export type CaseProgress = Pick<CaseResult, 'caseId' | 'seed' | 'status' | 'ticksExecuted'> &
  Partial<Pick<CaseResult, 'failure' | 'invalidStart' | 'error' | 'coverage'>>;
export type CaseViewResult = Pick<CaseResult, 'caseId' | 'seed' | 'status' | 'ticksExecuted' | 'trace'> &
  Partial<Pick<CaseResult, 'failure' | 'invalidStart' | 'error' | 'coverage'>>;

export type RunnerWorkerMessage = RunnerProgressMessage | RunnerCompleteMessage | RunnerErrorMessage;

export interface ValidationWorkerRequest {
  type: 'validate' | 'minimize';
  targetId: string;
  pkg: ProbePackage;
  map: string;
  scenario: ProbeScenarioId;
}

export interface MinimizeCancelRequest { type: 'cancel-minimize' }
export type ValidationWorkerCommand = ValidationWorkerRequest | MinimizeCancelRequest;

export type ValidationWorkerResponse =
  | { type: 'validated'; compatibility: { compatible: boolean; differences: string[] }; replay?: ReplayResult }
  | { type: 'minimized'; result: MinimizeResult }
  | { type: 'validation-error'; message: string };

export interface StoredCase {
  result: CaseViewResult;
  debugWorld?: DebugWorld;
  pkg?: ProbePackage;
}

export interface RunSettings {
  targetId: string;
  map: string;
  scenario: ProbeScenarioId;
  rootSeed: string;
  probeCount: number;
  simulationConcurrency: number;
  visibleProbeCount: number;
  maxTicks: number;
}

export interface CoverageSummary {
  visited: number;
  total: number;
  percent: number;
}

export function asRunRequest(
  scenario: ProbeScenario,
  caseId: string,
  seed: string,
  maxTicks: number,
): RunRequest {
  return { caseId, seed, world: scenario.world, config: scenario.config, start: scenario.start, maxTicks };
}
