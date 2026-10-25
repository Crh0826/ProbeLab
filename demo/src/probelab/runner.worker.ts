import { createProbePackage, createRunController } from '@probelab/core';
import type { CaseResult, DebugWorld, ProbeAdapter, RunController, RunRequest } from '@probelab/core';
import { getTarget } from './targets.js';
import { MAX_PROBE_TICKS, type CaseProgress, type RunnerWorkerCommand, type RunnerWorkerMessage } from './types.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<RunnerWorkerCommand>) => void) | null;
  postMessage(message: RunnerWorkerMessage): void;
}

const scope = self as unknown as WorkerScope;
const sliceTicks = 96;
let controller: RunController | undefined;
let adapter: ProbeAdapter | undefined;
let request: RunRequest | undefined;
let caseId: string | undefined;
let debugWorld: DebugWorld | undefined;
let paused = false;
let done = false;
let lastSentTraceLength = 0;
let scheduled = false;
let sliceTimer: ReturnType<typeof setTimeout> | undefined;
let caseGeneration = 0;

function post(message: RunnerWorkerMessage): void {
  scope.postMessage(message);
}

function summarize(result: CaseResult): CaseProgress {
  const summary: CaseProgress = {
    caseId: result.caseId,
    seed: result.seed,
    status: result.status,
    ticksExecuted: result.ticksExecuted,
  };
  if (result.failure !== undefined) summary.failure = result.failure;
  if (result.invalidStart !== undefined) summary.invalidStart = result.invalidStart;
  if (result.error !== undefined) summary.error = result.error;
  if (result.coverage !== undefined) summary.coverage = result.coverage;
  return summary;
}

function resetCase(): void {
  if (sliceTimer !== undefined) clearTimeout(sliceTimer);
  sliceTimer = undefined;
  caseGeneration += 1;
  controller = undefined;
  adapter = undefined;
  request = undefined;
  caseId = undefined;
  debugWorld = undefined;
  paused = false;
  done = false;
  lastSentTraceLength = 0;
  scheduled = false;
}

function finish(result: CaseResult, error?: string): void {
  if (done || caseId === undefined || adapter === undefined || request === undefined) return;
  done = true;
  if (sliceTimer !== undefined) clearTimeout(sliceTimer);
  sliceTimer = undefined;
  scheduled = false;
  const completedCaseId = caseId;
  const completedDebugWorld = debugWorld;
  try {
    const pkg = createProbePackage(adapter, request, result);
    post({ type: 'complete', caseId: completedCaseId, result, debugWorld: completedDebugWorld, package: pkg, ...(error === undefined ? {} : { error }) });
  } catch (cause) {
    post({ type: 'complete', caseId: completedCaseId, result, debugWorld: completedDebugWorld, error: error ?? (cause instanceof Error ? cause.message : String(cause)) });
  }
  resetCase();
}

function scheduleSlice(): void {
  if (scheduled || done || paused || controller === undefined) return;
  scheduled = true;
  const generation = caseGeneration;
  sliceTimer = setTimeout(() => {
    if (generation !== caseGeneration) return;
    sliceTimer = undefined;
    scheduled = false;
    if (done || paused || controller === undefined) return;
    try {
      const result = controller.advance(sliceTicks);
      const traceDelta = result.trace.slice(lastSentTraceLength);
      lastSentTraceLength = result.trace.length;
      post({
        type: 'progress',
        caseId: result.caseId,
        result: summarize(result),
        traceDelta,
        ...(debugWorld === undefined ? {} : { debugWorld }),
      });
      if (result.status === 'running') scheduleSlice();
      else finish(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (controller !== undefined) {
        const result = controller.result;
        result.status = 'failed';
        result.error = { name: 'ProbeWorkerError', message, tick: result.ticksExecuted };
        finish(result, message);
      } else {
        post({ type: 'error', ...(caseId === undefined ? {} : { caseId }), message });
      }
    }
  }, 0);
}

scope.onmessage = (event): void => {
  const command = event.data;
  if (command.type === 'run') {
    if (controller !== undefined && !done) return;
    resetCase();
    try {
      caseId = command.caseId;
      const target = getTarget(command.targetId);
      if (target === undefined) throw new Error(`Unknown ProbeLab target: ${command.targetId}`);
      const scenario = target.createScenario({
        seed: command.seed,
        map: command.map,
        scenario: command.scenario,
        caseIndex: command.caseIndex,
      });
      if (!Number.isInteger(command.maxTicks) || command.maxTicks < 1 || command.maxTicks > MAX_PROBE_TICKS) {
        post({ type: 'error', caseId: command.caseId, message: `每探针预算必须是 1–${MAX_PROBE_TICKS} 个整数 tick` });
        resetCase();
        return;
      }
      const maxTicks = command.maxTicks;
      request = {
        caseId: command.caseId,
        seed: command.seed,
        world: scenario.world,
        config: scenario.config,
        start: scenario.start,
        maxTicks,
      };
      adapter = target.adapter as typeof adapter;
      debugWorld = target.adapter.toDebugWorld(scenario.world);
      controller = createRunController(target.adapter, request, scenario.strategy);
      paused = command.initialPaused ?? false;
      if (paused) {
        const result = controller.pause();
        post({ type: 'progress', caseId: result.caseId, result: summarize(result), traceDelta: [], debugWorld });
      } else {
        scheduleSlice();
      }
    } catch (cause) {
      post({ type: 'error', caseId: command.caseId, message: cause instanceof Error ? cause.message : String(cause) });
      resetCase();
    }
    return;
  }
  if (controller === undefined || done) return;
  if (command.type === 'pause') {
    paused = true;
    const result = controller.pause();
    post({ type: 'progress', caseId: result.caseId, result: summarize(result), traceDelta: [] });
  } else if (command.type === 'resume') {
    paused = false;
    controller.resume();
    scheduleSlice();
  } else if (command.type === 'stop') {
    paused = false;
    finish(controller.cancel());
  }
};
