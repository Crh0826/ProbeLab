import {
  checkCompatibility,
  createProbePackage,
  createRunController,
  importProbePackage,
  minimizeFailureAsync,
  replayPackage,
  type CaseResult,
  type ProbePackage,
  type ReplayResult
} from '@probelab/core';
import { resolve, dirname } from 'node:path';
import { MAX_CASE_TICKS, parseArgs, helpText } from './args.js';
import { releaseRunData, statusForResult, toCaseReport, toReportResult } from './cli-result.js';
import { createNodeIO } from './node-io.js';
import { stableJson, writeRunArtifacts, writeSingleReport, type CaseReport } from './report.js';
import {
  CliInputError,
  isProbePackage,
  type ParsedArgs,
  type ProbeCliIO,
  type ProbeCliResult,
  type ProbeRegistry,
  type ProbeRegressionFixture,
  type ProbeTarget
} from './types.js';

const DEFAULT_IMPORT_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 2_000_000,
  maxArrayLength: 1_000_000,
  maxStringLength: 2_000_000,
  maxCommands: MAX_CASE_TICKS,
  maxTraceTicks: MAX_CASE_TICKS
} as const;
const TICK_BATCH = 120;

export async function main(args: readonly string[], registry: ProbeRegistry, suppliedIO?: ProbeCliIO): Promise<ProbeCliResult> {
  const io = suppliedIO ?? createNodeIO();
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      const report = { kind: 'probelab-cli', command: 'help', help: helpText() };
      io.stdout(`${stableJson(report)}\n`);
      return { exitCode: 0, report };
    }
    validateRegistry(registry);
    switch (parsed.command) {
      case 'run': return await runCommand(parsed, registry, io);
      case 'replay': return await packageCommand('replay', parsed, registry, io);
      case 'regress': return await packageCommand('regress', parsed, registry, io);
      case 'minimize': return await packageCommand('minimize', parsed, registry, io);
      case 'check': return await packageCommand('check', parsed, registry, io);
      case 'help': {
        const report = { kind: 'probelab-cli', command: 'help', help: helpText() };
        io.stdout(`${stableJson(report)}\n`);
        return { exitCode: 0, report };
      }
    }
  } catch (error) {
    const exitCode: ProbeCliResult['exitCode'] = error instanceof CliInputError ? 2 : 2;
    const report = {
      kind: 'probelab-cli-error',
      exitCode,
      error: serializeError(error)
    };
    io.stderr(`${report.error.message}\n`);
    io.stdout(`${stableJson(report)}\n`);
    return { exitCode, report };
  }
}

async function runCommand(args: ParsedArgs, registry: ProbeRegistry, io: ProbeCliIO): Promise<ProbeCliResult> {
  const target = getTarget(registry, args.adapter);
  const outputDir = resolve(io.cwd(), args.outputDir);
  let interrupted = false;
  const removeInterrupt = io.onInterrupt?.(() => {
    interrupted = true;
    io.stderr('Interrupt received; finishing the current tick batch and preserving partial results.\n');
  });
  const executions: Array<{ result: CaseResult; packet?: ProbePackage; packetJson?: string; packageOmittedReason?: string; coverage?: CaseReport['coverage'] }> = [];
  let savedFaultPackages = 0;
  let evidenceBytes = 0;
  try {
    const runProbe = async (index: number): Promise<{ result: CaseResult; packet?: ProbePackage }> => {
      const caseId = `probe-${String(index + 1).padStart(4, '0')}`;
      const seed = `${args.seed}/${target.id}/${args.map ?? 'default'}/${caseId}`;
      let result: CaseResult;
      let packet: ProbePackage | undefined;
      try {
        const scenario = target.createScenario({ seed, map: args.map, scenario: args.scenario ?? 'healthy' });
        const request = {
          caseId,
          seed,
          world: scenario.world,
          config: scenario.config,
          start: scenario.start,
          maxTicks: args.ticks
        };
        const controller = createRunController(target.adapter, request, scenario.strategy);
        while (controller.result.status === 'running' && !interrupted) {
          controller.advance(TICK_BATCH);
          if (controller.result.status === 'running') await io.yield();
        }
        if (interrupted && controller.result.status === 'running') controller.cancel('SIGINT');
        result = controller.result;
        if (result.failure || result.invalidStart || result.status === 'cancelled' || args.saveAll) {
          try {
            packet = createProbePackage(target.adapter, request, result);
          } catch (error) {
            result.error = {
              name: error instanceof Error ? error.name : 'Error',
              message: `Could not export the run package: ${errorMessage(error)}`,
              tick: result.ticksExecuted
            };
          }
        }
      } catch (error) {
        result = {
          caseId,
          seed,
          rngInitial: { algorithm: 'xoshiro128ss-v1', state: [0, 0, 0, 0] },
          rngFinal: { algorithm: 'xoshiro128ss-v1', state: [0, 0, 0, 0] },
          initialState: null,
          inputs: {
            world: null,
            config: null,
            start: null,
            debugWorld: {
              mapId: args.map ?? 'unavailable',
              coordinateSystem: target.adapter.descriptor.coordinateSystem,
              units: target.adapter.descriptor.units,
              colliders: []
            },
            worldHash: '',
            configHash: ''
          },
          coverage: { visits: {}, visited: 0 },
          status: 'failed',
          ticksExecuted: 0,
          trace: [],
          error: { name: error instanceof Error ? error.name : 'Error', message: errorMessage(error), tick: 0 }
        };
      }
      io.stderr(`${caseId}: ${result.status}, ${result.ticksExecuted}/${args.ticks} ticks${result.failure ? `, ${result.failure.kind}` : ''}\n`);
      return { result, packet };
    };

    for (let offset = 0; offset < args.probes && !interrupted; offset += args.concurrency) {
      const count = Math.min(args.concurrency, args.probes - offset);
      const batch = await Promise.all(Array.from({ length: count }, (_unused, localIndex) => runProbe(offset + localIndex)));
      batch.sort((a, b) => compareText(a.result.caseId, b.result.caseId));
      for (const entry of batch) {
        const execution: { result: CaseResult; packet?: ProbePackage; packetJson?: string; packageOmittedReason?: string; coverage?: CaseReport['coverage'] } = {
          result: entry.result,
          packet: entry.packet,
          coverage: {
            visited: entry.result.coverage.visited,
            ...(entry.result.coverage.capacity === undefined ? {} : { capacity: entry.result.coverage.capacity }),
            ...(entry.result.coverage.ratio === undefined ? {} : { ratio: entry.result.coverage.ratio })
          }
        };
        if (entry.packet) {
          const faultPacket = entry.packet.outcome.status === 'failed';
          if (faultPacket && savedFaultPackages >= args.maxFaults) {
            execution.packageOmittedReason = `max-faults limit (${args.maxFaults}) reached`;
          } else {
            const packetJson = stableJson(entry.packet);
            const packetBytes = new TextEncoder().encode(packetJson).byteLength + 1;
            if (evidenceBytes + packetBytes > args.maxOutputBytes) {
              execution.packageOmittedReason = `packet evidence byte limit (${args.maxOutputBytes}) reached`;
            } else {
              execution.packetJson = packetJson;
              evidenceBytes += packetBytes;
              if (faultPacket) savedFaultPackages += 1;
            }
          }
          execution.packet = undefined;
          entry.packet = undefined;
        }
        releaseRunData(execution.result, target);
        executions.push(execution);
      }
    }
  } catch (error) {
    removeInterrupt?.();
    throw error;
  }

  executions.sort((a, b) => compareText(a.result.caseId, b.result.caseId));
  const casePaths: Record<string, string> = {};
  for (const item of executions) if (item.packetJson) casePaths[item.result.caseId] = `cases/${safeFilePart(item.result.caseId)}.probe.json`;
  const caseReports: CaseReport[] = executions.map(({ result, packageOmittedReason, coverage }) => toCaseReport(result, casePaths[result.caseId], packageOmittedReason, coverage));
  const coverageRatios = executions.flatMap(({ coverage }) => coverage?.ratio === undefined ? [] : [coverage.ratio]);
  const errors = executions.filter(({ result }) => result.error).length;
  const invalidStarts = executions.filter(({ result }) => result.invalidStart).length;
  const failures = executions.filter(({ result }) => result.failure).length;
  const cancelled = interrupted || executions.some(({ result }) => result.status === 'cancelled') || executions.length < args.probes;
  const exitCode: ProbeCliResult['exitCode'] = cancelled ? 130 : (errors > 0 || invalidStarts > 0 ? 2 : failures > 0 ? 1 : 0);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'probelab-report',
    command: 'run',
    status: cancelled ? 'incomplete' : errors > 0 || invalidStarts > 0 ? 'error' : failures > 0 ? 'faults-found' : 'complete',
    exitCode,
    target: { id: target.id, descriptor: target.adapter.descriptor },
    config: {
      seed: args.seed,
      map: args.map ?? 'default',
      scenario: args.scenario ?? 'healthy',
      probes: args.probes,
      ticks: args.ticks,
      concurrency: args.concurrency,
      maxFaults: args.maxFaults,
      maxOutputBytes: args.maxOutputBytes
    },
    summary: {
      casesRequested: args.probes,
      casesCompleted: executions.length,
      healthy: executions.filter(({ result }) => result.status === 'complete' && !result.failure).length,
      failures,
      savedPackages: Object.values(casePaths).length,
      omittedPackages: executions.filter(({ packageOmittedReason }) => packageOmittedReason !== undefined).length,
      evidenceBytes,
      invalidStarts,
      errors,
      cancelled: cancelled ? 1 : 0,
      ticksExecuted: executions.reduce((sum, { result }) => sum + result.ticksExecuted, 0),
      uniqueFaultSignatures: new Set(executions.flatMap(({ result }) => result.failure ? [signatureKey(result.failure.signature)] : [])).size
    },
    coverage: {
      definition: 'Distinct adapter strategy coverageKey buckets visited per case; ratios exist only when the adapter declares a coverage capacity.',
      casesWithCapacity: coverageRatios.length,
      meanPerCaseRatio: coverageRatios.length ? coverageRatios.reduce((sum, ratio) => sum + ratio, 0) / coverageRatios.length : undefined
    },
    cases: caseReports
  };
  try {
    const artifactPaths = [
      ...(args.format === 'json' || args.format === 'both' ? ['report.json'] : []),
      ...(args.format === 'md' || args.format === 'both' ? ['report.md'] : [])
    ];
    const reportWithArtifacts = { ...report, artifacts: artifactPaths };
    await writeRunArtifacts(io, outputDir, reportWithArtifacts, executions, args.format);
    io.stdout(`${stableJson(reportWithArtifacts)}\n`);
    return { exitCode, report: reportWithArtifacts };
  } finally {
    removeInterrupt?.();
  }
}

async function packageCommand(
  command: 'replay' | 'regress' | 'minimize' | 'check',
  args: ParsedArgs,
  registry: ProbeRegistry,
  io: ProbeCliIO
): Promise<ProbeCliResult> {
  const outputDir = resolve(io.cwd(), args.outputDir);
  const inputPath = resolve(io.cwd(), args.input!);
  const document = await readDocument(inputPath, args.maxBytes, io);
  const fixture = document.fixture;
  const packet = document.packet;
  let target: ProbeTarget<any> | undefined;
  let result: unknown;
  let exitCode: ProbeCliResult['exitCode'] = 0;
  let fixtureToWrite: string | undefined;
  const extraFiles: Record<string, string> = {};
  let minimizedPackagePath: string | undefined;
  let minimizedPackageOmittedReason: string | undefined;

  if (command === 'check') {
    const requested = args.adapter ?? packet.descriptor.adapterId;
    target = getTarget(registry, requested, true);
    if (!target) {
      exitCode = 2;
      result = { compatible: false, differences: [`No trusted adapter is registered for "${requested}".`] };
    } else {
      result = checkCompatibility(packet, target.adapter);
      exitCode = (result as { compatible: boolean }).compatible ? 0 : 2;
    }
  } else if (command === 'replay') {
    target = getTarget(registry, args.adapter ?? packet.descriptor.adapterId, true);
    if (!target) {
      exitCode = 2;
      result = { status: 'incompatible', compatible: false, reason: `No trusted adapter is registered for "${args.adapter ?? packet.descriptor.adapterId}".`, targetDifferences: [] };
    } else {
      const replay = replayPackage(target.adapter, packet, { mode: 'strict' });
      result = replay;
      exitCode = replayExitCode(replay, packet, 'strict');
    }
  } else if (command === 'regress') {
    if (packet.outcome.status !== 'failed' || !packet.outcome.failure) {
      throw new CliInputError('regress requires a ProbePackage with a recorded motion-time failure; invalid-start, incomplete, and healthy records are not regression baselines.');
    }
    const requested = args.adapter ?? fixture?.target.adapterId ?? registry.defaultTarget;
    target = getTarget(registry, requested, true);
    if (!target) {
      exitCode = 2;
      result = { status: 'incompatible', compatible: false, reason: `No trusted adapter is registered for "${requested}".`, targetDifferences: [] };
    } else {
    if (fixture && fixture.target.scenario !== args.targetScenario) {
        throw new CliInputError(`Fixture target scenario is "${fixture.target.scenario}"; use --target-scenario ${fixture.target.scenario}.`);
      }
      if (fixture && fixture.target.adapterId !== target.id) {
        throw new CliInputError(`Fixture targets adapter "${fixture.target.adapterId}"; selected adapter is "${target.id}".`);
      }
      const targetScenario = target.createScenario({
        seed: packet.case.seed,
        map: args.map ?? fixture?.target.map,
        scenario: args.targetScenario
      });
      const replay = replayPackage(target.adapter, packet, {
        mode: 'regress',
        targetWorld: targetScenario.world,
        targetConfig: targetScenario.config
      });
      const policy = fixture?.target.compatibilityPolicy ?? {
        adapterStructure: 'must-be-compatible' as const,
        world: args.allowWorldChange ? 'declared-change-allowed' as const : 'unchanged' as const,
        config: args.allowConfigChange ? 'declared-change-allowed' as const : 'unchanged' as const
      };
      const deniedDifferences = deniedTargetDifferences(replay.targetDifferences, policy.world, policy.config);
      result = deniedDifferences.length > 0
        ? { ...replay, compatible: false, status: 'incompatible', reason: `Undeclared target changes: ${deniedDifferences.join(', ')}`, targetDifferences: replay.targetDifferences }
        : replay;
      exitCode = deniedDifferences.length > 0 ? 2 : replayExitCode(replay, packet, 'regress');
      if (args.fixtureOut) {
        fixtureToWrite = makeFixture(packet, target.id, args.map, args.targetScenario!, policy);
      }
    }
  } else {
    target = getTarget(registry, args.adapter ?? packet.descriptor.adapterId, true);
    if (!target) {
      exitCode = 2;
      result = { status: 'incompatible', reason: `No trusted adapter is registered for "${args.adapter ?? packet.descriptor.adapterId}".` };
    } else {
      const scenario = target.createScenario({
        seed: packet.case.seed,
        map: args.map,
        scenario: args.scenario ?? 'healthy'
      });
      let interrupted = false;
      const removeInterrupt = io.onInterrupt?.(() => { interrupted = true; });
      try {
        const minimized = await minimizeFailureAsync(target.adapter, packet, scenario.strategy, {
          maxRuns: args.maxRuns,
          maxTicks: args.maxMinimizeTicks,
          maxMilliseconds: args.maxMilliseconds,
          isCancelled: () => interrupted,
          clock: () => io.now()
        }, { yield: () => io.yield() });
        result = minimized;
        if (minimized.package) {
          const packageJson = stableJson(minimized.package);
          const packetBytes = new TextEncoder().encode(packageJson).byteLength + 1;
          if (packetBytes > args.maxOutputBytes) {
            minimizedPackageOmittedReason = `packet evidence byte limit (${args.maxOutputBytes}) reached`;
            exitCode = 2;
          } else {
            minimizedPackagePath = 'minimized.probe.json';
            extraFiles[minimizedPackagePath] = `${packageJson}\n`;
          }
        }
        if (interrupted || minimized.status === 'cancelled') exitCode = 130;
        else if (minimized.status === 'not-reproducible') exitCode = 1;
      } finally {
        removeInterrupt?.();
      }
    }
  }

  if (args.fixtureOut && fixtureToWrite) {
    if (new TextEncoder().encode(fixtureToWrite).byteLength + 1 > args.maxOutputBytes) {
      throw new CliInputError(`Regression fixture exceeds the ${args.maxOutputBytes}-byte output evidence limit.`);
    }
    const targetPath = resolve(io.cwd(), args.fixtureOut);
    await io.mkdir(dirname(targetPath));
    await io.writeFile(targetPath, `${fixtureToWrite}\n`);
  }

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'probelab-report',
    command,
    status: statusForResult(command, result, exitCode),
    exitCode,
    target: target ? { id: target.id, descriptor: target.adapter.descriptor } : undefined,
    config: {
      input: args.input,
      map: args.map ?? fixture?.target.map ?? 'package',
      scenario: command === 'regress' ? args.targetScenario : args.scenario,
      mode: command === 'regress' ? 'regress' : 'strict',
      budgets: command === 'minimize' ? { runs: args.maxRuns, ticks: args.maxMinimizeTicks, milliseconds: args.maxMilliseconds } : undefined,
      maxOutputBytes: args.maxOutputBytes,
      targetCompatibilityPolicy: fixture?.target.compatibilityPolicy ?? {
        world: args.allowWorldChange ? 'declared-change-allowed' : 'unchanged',
        config: args.allowConfigChange ? 'declared-change-allowed' : 'unchanged'
      }
    },
    baseline: { status: packet.outcome.status, failure: packet.outcome.failure },
    result: toReportResult(command, result, minimizedPackagePath, minimizedPackageOmittedReason),
    fixture: fixtureToWrite ? args.fixtureOut : fixture ? { expected: fixture.expected, target: fixture.target } : undefined
  };
  const artifactPaths = await writeSingleReport(io, outputDir, report, args.format, extraFiles);
  const completeReport = { ...report, artifacts: artifactPaths };
  io.stdout(`${stableJson(completeReport)}\n`);
  return { exitCode, report: completeReport };
}

async function readDocument(
  path: string,
  maxBytes: number,
  io: ProbeCliIO
): Promise<{ packet: ProbePackage; fixture?: ProbeRegressionFixture }> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path, maxBytes);
  } catch (error) {
    throw new CliInputError(`Cannot read input file: ${errorMessage(error)}`);
  }
  if (bytes.byteLength > maxBytes) throw new CliInputError(`Input exceeds the ${maxBytes}-byte size limit.`);
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliInputError(`Input is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
  if (isRegressionFixture(parsed)) {
    const nestedBytes = new TextEncoder().encode(JSON.stringify(parsed.source));
    if (nestedBytes.byteLength > maxBytes) throw new CliInputError(`Fixture package exceeds the ${maxBytes}-byte size limit.`);
    const importedFixturePackage = importProbePackage(nestedBytes, { ...DEFAULT_IMPORT_LIMITS, maxBytes });
    if (!importedFixturePackage.ok) throw new CliInputError(`Invalid fixture source package (${importedFixturePackage.code}): ${importedFixturePackage.message}`);
    const fixture = { ...parsed, source: importedFixturePackage.value };
    validateFixture(fixture);
    return { packet: fixture.source, fixture };
  }
  const imported = importProbePackage(bytes, { ...DEFAULT_IMPORT_LIMITS, maxBytes });
  if (!imported.ok) throw new CliInputError(`Invalid ProbePackage (${imported.code}): ${imported.message}`);
  return { packet: imported.value };
}

function isRegressionFixture(value: unknown): value is ProbeRegressionFixture {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value as Partial<ProbeRegressionFixture>).kind === 'probelab-regression-fixture';
}

function validateFixture(fixture: ProbeRegressionFixture): void {
  if (fixture.schemaVersion !== 1 || fixture.expected !== 'healthy' || !isProbePackage(fixture.source)) {
    throw new CliInputError('Unsupported or malformed regression fixture.');
  }
  if (fixture.source.outcome.status !== 'failed' || !fixture.source.outcome.failure) {
    throw new CliInputError('Regression fixture must preserve a source package with an actual recorded failure.');
  }
  const actualSignature = signatureKey(fixture.source.outcome.failure.signature);
  if (fixture.baseline.outcome !== 'failed' || fixture.baseline.failureSignature !== actualSignature) {
    throw new CliInputError('Regression fixture baseline does not match the recorded source failure.');
  }
  if (fixture.target.mode !== 'regress' || fixture.target.compatibilityPolicy.adapterStructure !== 'must-be-compatible') {
    throw new CliInputError('Regression fixture target compatibility policy is not supported.');
  }
}

function makeFixture(
  packet: ProbePackage,
  adapterId: string,
  map: string | undefined,
  scenario: string,
  compatibilityPolicy: ProbeRegressionFixture['target']['compatibilityPolicy']
): string {
  if (packet.outcome.status !== 'failed' || !packet.outcome.failure) {
    throw new CliInputError('A regression fixture requires a source package that recorded an actual failure.');
  }
  const fixture: ProbeRegressionFixture = {
    schemaVersion: 1,
    kind: 'probelab-regression-fixture',
    expected: 'healthy',
    source: packet,
    baseline: {
      outcome: 'failed',
      failureSignature: signatureKey(packet.outcome.failure.signature)
    },
    target: { adapterId, ...(map === undefined ? {} : { map }), scenario, mode: 'regress', compatibilityPolicy }
  };
  return stableJson(fixture);
}

function deniedTargetDifferences(
  differences: readonly string[],
  worldPolicy: 'unchanged' | 'declared-change-allowed',
  configPolicy: 'unchanged' | 'declared-change-allowed'
): string[] {
  return differences.filter((difference) => {
    const normalized = difference.toLowerCase();
    if (normalized.includes('world')) return worldPolicy !== 'declared-change-allowed';
    if (normalized.includes('config')) return configPolicy !== 'declared-change-allowed';
    return false;
  });
}

function replayExitCode(result: ReplayResult, packet: ProbePackage, mode: 'strict' | 'regress'): ProbeCliResult['exitCode'] {
  if (packet.outcome.status === 'incomplete' || packet.outcome.invalidStart || packet.outcome.error) return 2;
  if (result.status === 'incompatible' || !result.compatible) return 2;
  if (result.status === 'error') return 2;
  if (mode === 'strict') {
    if (packet.outcome.status === 'failed' && result.status === 'verified-failure') return 0;
    if (packet.outcome.status === 'healthy' && result.status === 'healthy') return 0;
    return 1;
  }
  return result.status === 'healthy' ? 0 : 1;
}

function getTarget(registry: ProbeRegistry, id: string | undefined, optional: true): ProbeTarget<any> | undefined;
function getTarget(registry: ProbeRegistry, id?: string, optional?: false): ProbeTarget<any>;
function getTarget(registry: ProbeRegistry, id?: string, optional = false): ProbeTarget<any> | undefined {
  const targetId = id ?? registry.defaultTarget;
  const target = registry.targets[targetId] ?? Object.values(registry.targets).find((candidate) => candidate.id === targetId || candidate.adapter.descriptor.adapterId === targetId);
  if (!target && !optional) throw new CliInputError(`No trusted adapter is registered for "${targetId}".`);
  return target;
}

function validateRegistry(registry: ProbeRegistry): void {
  if (!registry || typeof registry !== 'object' || !registry.targets || typeof registry.targets !== 'object') {
    throw new CliInputError('A trusted ProbeRegistry must be supplied to the CLI.');
  }
  if (!registry.targets[registry.defaultTarget]) throw new CliInputError(`Default target "${registry.defaultTarget}" is not registered.`);
  for (const [id, target] of Object.entries(registry.targets)) {
    if (id !== target.id || typeof target.createScenario !== 'function' || !target.adapter?.descriptor) {
      throw new CliInputError(`Invalid trusted registry entry "${id}".`);
    }
  }
}

function signatureKey(signature: { kind: string; target: string }): string {
  return `${signature.kind}:${signature.target}`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'case';
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

