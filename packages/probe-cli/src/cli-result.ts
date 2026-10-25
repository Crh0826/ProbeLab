import type { CaseResult } from '@probelab/core';
import type { CaseReport } from './report.js';
import type { ProbeTarget } from './types.js';

export function statusForResult(command: string, result: unknown, exitCode: number): string {
  if (exitCode === 130) return 'incomplete';
  if (exitCode === 2) return 'error';
  if (command === 'run') return exitCode === 1 ? 'faults-found' : 'complete';
  if (command === 'regress') return exitCode === 0 ? 'healthy' : exitCode === 1 ? 'regression-failed' : 'error';
  if (command === 'replay') return exitCode === 0 ? 'verified' : exitCode === 1 ? 'diverged' : 'error';
  if (command === 'minimize' && isRecord(result)) return String(result.status ?? 'complete');
  return exitCode === 1 ? 'failed' : 'complete';
}

export function toReportResult(command: string, result: unknown, minimizedPackagePath?: string, packageOmittedReason?: string): unknown {
  if (!isRecord(result)) return result;
  if (command === 'minimize') {
    const summary: Record<string, unknown> = {};
    for (const key of ['status', 'originalLength', 'reducedLength', 'attempts', 'replayVerifications', 'elapsedMilliseconds', 'stopReason']) {
      if (result[key] !== undefined) summary[key] = result[key];
    }
    if (minimizedPackagePath) summary.packagePath = minimizedPackagePath;
    if (packageOmittedReason) summary.packageOmittedReason = packageOmittedReason;
    return summary;
  }
  if (command === 'replay' || command === 'regress') {
    const summary: Record<string, unknown> = {};
    for (const key of ['compatible', 'status', 'ticksExecuted', 'firstDivergentTick', 'reason', 'targetDifferences']) {
      if (result[key] !== undefined) summary[key] = result[key];
    }
    const caseResult = isRecord(result.result) ? result.result : undefined;
    if (caseResult) {
      summary.caseStatus = caseResult.status;
      summary.failure = caseResult.failure;
      summary.error = caseResult.error;
    }
    return summary;
  }
  return result;
}

export function toCaseReport(result: CaseResult, packagePath?: string, packageOmittedReason?: string, coverage?: CaseReport['coverage']): CaseReport {
  const item: CaseReport = {
    caseId: result.caseId,
    seed: result.seed,
    status: result.status,
    ticksExecuted: result.ticksExecuted
  };
  if (result.failure) item.fault = {
    kind: result.failure.kind,
    target: result.failure.signature.target,
    tick: result.failure.tick
  };
  if (result.invalidStart) item.invalidStart = { reason: readReason(result.invalidStart.detail) };
  if (result.error) item.error = result.error;
  if (packagePath) item.packagePath = packagePath;
  if (packageOmittedReason) item.packageOmittedReason = packageOmittedReason;
  if (coverage) item.coverage = coverage;
  return item;
}

export function releaseRunData(result: CaseResult, target: ProbeTarget<any>): void {
  result.trace.length = 0;
  result.initialState = null;
  result.inputs = {
    world: null,
    config: null,
    start: null,
    debugWorld: {
      mapId: 'released',
      coordinateSystem: target.adapter.descriptor.coordinateSystem,
      units: target.adapter.descriptor.units,
      colliders: []
    },
    worldHash: '',
    configHash: ''
  };
  result.coverage = { visits: {}, visited: 0 };
}

function readReason(value: unknown): string {
  return isRecord(value) && typeof value.reason === 'string' ? value.reason : 'Invalid start state.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
