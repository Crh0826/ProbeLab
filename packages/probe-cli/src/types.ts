import type { CommandStrategy, ProbeAdapter, ProbePackage } from '@probelab/core';

export type ProbeScenarioName = 'healthy' | 'drop' | 'penetration' | 'non-finite' | string;

export interface ProbeScenario<State = unknown> {
  world: unknown;
  config: unknown;
  start: unknown;
  strategy: CommandStrategy<State>;
  maxTicks?: number;
}

/**
 * A trusted, host-supplied target. CLI input can select its ID and scenario,
 * but cannot supply code or module paths.
 */
export interface ProbeTarget<State = unknown> {
  id: string;
  adapter: ProbeAdapter<State>;
  createScenario(options: {
    seed: string;
    map?: string;
    scenario?: ProbeScenarioName;
  }): ProbeScenario<State>;
}

export interface ProbeRegistry {
  defaultTarget: string;
  targets: Readonly<Record<string, ProbeTarget<any>>>;
}

export type ReportFormat = 'json' | 'md' | 'both';
export type ProbeCommand = 'run' | 'replay' | 'regress' | 'minimize' | 'check' | 'help';

export interface ParsedArgs {
  command: ProbeCommand;
  help: boolean;
  adapter?: string;
  map?: string;
  scenario?: string;
  targetScenario?: string;
  seed: string;
  probes: number;
  ticks: number;
  concurrency: number;
  outputDir: string;
  format: ReportFormat;
  input?: string;
  mode: 'strict' | 'regress';
  maxRuns: number;
  maxMinimizeTicks: number;
  maxMilliseconds: number;
  maxBytes: number;
  maxFaults: number;
  maxOutputBytes: number;
  allowWorldChange: boolean;
  allowConfigChange: boolean;
  fixtureOut?: string;
  saveAll: boolean;
}

export interface ProbeRegressionFixture {
  schemaVersion: 1;
  kind: 'probelab-regression-fixture';
  expected: 'healthy';
  source: ProbePackage;
  baseline: {
    outcome: 'failed';
    failureSignature: string;
  };
  target: {
    adapterId: string;
    map?: string;
    scenario: string;
    mode: 'regress';
    compatibilityPolicy: {
      adapterStructure: 'must-be-compatible';
      world: 'unchanged' | 'declared-change-allowed';
      config: 'unchanged' | 'declared-change-allowed';
    };
  };
}

export interface ProbeCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  cwd(): string;
  yield(): Promise<void>;
  now(): number;
  onInterrupt?(handler: () => void): () => void;
}

export interface ProbeCliResult {
  exitCode: 0 | 1 | 2 | 130;
  report?: Record<string, unknown>;
}

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

export function isProbePackage(value: unknown): value is ProbePackage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const packet = value as Partial<ProbePackage>;
  return packet.kind === 'probelab-package' && packet.schemaVersion === 1;
}

