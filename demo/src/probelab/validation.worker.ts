import { checkCompatibility, minimizeFailureAsync, replayPackage } from '@probelab/core';
import { getTarget } from './targets.js';
import type { ValidationWorkerCommand, ValidationWorkerRequest, ValidationWorkerResponse } from './types.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ValidationWorkerCommand>) => void) | null;
  postMessage(message: ValidationWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
let cancellationRequested = false;
scope.onmessage = (event): void => {
  if (event.data.type === 'cancel-minimize') {
    cancellationRequested = true;
    return;
  }
  void handleRequest(event.data);
};

async function handleRequest(request: ValidationWorkerRequest): Promise<void> {
  const { type, targetId, pkg, map, scenario } = request;
  try {
    const target = getTarget(targetId);
    if (target === undefined) throw new Error(`Unknown ProbeLab target: ${targetId}`);
    if (type === 'validate') {
      const compatibility = checkCompatibility(pkg, target.adapter);
      const replay = compatibility.compatible ? replayPackage(target.adapter, pkg, { mode: 'strict' }) : undefined;
      scope.postMessage({ type: 'validated', compatibility, ...(replay === undefined ? {} : { replay }) });
      return;
    }
    const strategy = target.createScenario({ seed: pkg.case.seed, map, scenario }).strategy;
    cancellationRequested = false;
    const result = await minimizeFailureAsync(target.adapter, pkg, strategy, {
      maxRuns: 96,
      maxTicks: Math.max(1, pkg.case.maxTicks * 96),
      maxMilliseconds: 20_000,
      clock: () => performance.now(),
      isCancelled: () => cancellationRequested,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    scope.postMessage({ type: 'minimized', result });
  } catch (cause) {
    scope.postMessage({ type: 'validation-error', message: cause instanceof Error ? cause.message : String(cause) });
  }
}
