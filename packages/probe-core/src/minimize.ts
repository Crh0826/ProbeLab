import { assertDataDTO, canonicalHash, canonicalJson } from './canonical.js';
import { createProbePackage } from './package.js';
import { createRunController } from './runner.js';
import type { CaseResult, CommandStrategy, DataDTO, MinimizeBudget, MinimizeResult, ProbeAdapter, ProbePackage, RunRequest } from './types.js';

type StopReason = 'cancelled' | 'budget';
type CandidateRun = { result?: CaseResult; reason?: StopReason };

export function minimizeFailure<State>(adapter: ProbeAdapter<State>, source: ProbePackage, strategy: CommandStrategy<State>, budget: MinimizeBudget): MinimizeResult {
  const started = budget.clock?.();
  const originalCommands = source.encoded.commands.map(cloneData);
  const originalLength = originalCommands.length;
  let attempts = 0; let replayVerifications = 0; let ticksUsed = 0;
  let bestCommands = [...originalCommands];
  // The original artifact is a safe fallback. A smaller candidate is promoted
  // only after two independent verifier runs agree on the complete failure.
  let bestPackage: ProbePackage | undefined = source;
  let bestCandidateVerified = false;
  const elapsed = (): number => {
    const now = budget.clock?.();
    return typeof now === 'number' && Number.isFinite(now) ? Math.max(0, now - (started as number)) : Number.POSITIVE_INFINITY;
  };
  if (typeof budget.clock !== 'function' || !Number.isFinite(started)) return report('budget-exhausted', 'budget.clock must be injected and return a finite starting value');
  if (!validBudget(budget)) return report('budget-exhausted', 'invalid minimization budget');
  const targetSignature = source.outcome.failure?.signature;
  if (source.outcome.status !== 'failed' || !targetSignature || source.outcome.invalidStart) return report('not-reproducible', 'source package has no motion-time first failure to minimize');

  const makeRequest = (commandCount: number): RunRequest => ({
    caseId: source.case.caseId, seed: source.case.seed, maxTicks: commandCount,
    world: adapter.decodeWorld(cloneData(source.encoded.world)),
    config: adapter.decodeConfig(cloneData(source.encoded.config)),
    start: adapter.decodeStart(cloneData(source.encoded.start)),
  });
  const normalizeCandidate = (commands: DataDTO[]): DataDTO[] => {
    const output = strategy.normalizeCommands?.(commands.map(cloneData)) ?? commands;
    if (!Array.isArray(output) || output.length !== commands.length) throw new TypeError('normalizeCommands must preserve candidate length');
    return output.map((command) => {
      assertDataDTO(command);
      const normalized = cloneData(adapter.encodeCommand(adapter.decodeCommand(cloneData(command))));
      if (canonicalHash(normalized) !== canonicalHash(command)) throw new TypeError('normalized command does not round-trip through the adapter codec');
      return normalized;
    });
  };
  const stopWithinRun = (): StopReason | undefined => {
    if (budget.isCancelled?.()) return 'cancelled';
    if (ticksUsed >= budget.maxTicks || elapsed() >= budget.maxMilliseconds) return 'budget';
    return undefined;
  };
  const stopBeforeRun = (): StopReason | undefined => stopWithinRun() ?? (attempts >= budget.maxRuns ? 'budget' : undefined);
  const execute = (commands: DataDTO[]): CandidateRun => {
    const beforeStart = stopBeforeRun();
    if (beforeStart) return { reason: beforeStart };
    attempts++;
    const request = makeRequest(commands.length);
    let index = 0;
    const candidateStrategy: CommandStrategy<State> = {
      nextCommand() {
        const recorded = commands[index++];
        if (recorded === undefined) throw new Error('minimizer command stream ended early');
        return adapter.decodeCommand(cloneData(recorded));
      },
    };
    let controller;
    try { controller = createRunController(adapter, request, candidateStrategy); }
    catch { return { reason: 'budget' }; }
    while (controller.result.status === 'running') {
      const stop = stopWithinRun();
      if (stop) { controller.cancel(stop === 'cancelled' ? 'cancelled during minimization' : 'minimization budget exhausted'); return { result: controller.result, reason: stop }; }
      const before = controller.result.ticksExecuted;
      const result = controller.advance(1);
      ticksUsed += result.ticksExecuted - before;
      // One synchronous simulation tick is atomic. Stop immediately after it if
      // the injected deadline has expired; never start a following tick.
      if (elapsed() >= budget.maxMilliseconds) { controller.cancel('minimization time budget exhausted'); return { result: controller.result, reason: 'budget' }; }
      if (result.status === 'running' && ticksUsed >= budget.maxTicks) {
        controller.cancel('minimization tick budget exhausted');
        return { result: controller.result, reason: 'budget' };
      }
    }
    return { result: controller.result };
  };
  const matchesTarget = (result: CaseResult | undefined): boolean => !!result?.failure && canonicalHash(result.failure.signature) === canonicalHash(targetSignature);
  const reserveCandidateBudget = (commands: DataDTO[]): StopReason | undefined => {
    const stop = stopBeforeRun();
    if (stop) return stop;
    // Keep room for the trial and both independent verifications. Using the
    // command count is conservative: each replay may consume its full prefix.
    if (attempts + 3 > budget.maxRuns || ticksUsed + commands.length * 3 > budget.maxTicks) return 'budget';
    return undefined;
  };
  const verifyAndPromote = (commands: DataDTO[], trial: CaseResult): { promoted: boolean; reason?: StopReason } => {
    if (!matchesTarget(trial)) return { promoted: false };
    const beforeA = attempts;
    const verificationA = execute(commands);
    replayVerifications += attempts - beforeA;
    if (verificationA.reason) return { promoted: false, reason: verificationA.reason };
    if (!matchesTarget(verificationA.result) || !verificationA.result?.failure) return { promoted: false };

    const beforeB = attempts;
    const verificationB = execute(commands);
    replayVerifications += attempts - beforeB;
    if (verificationB.reason) return { promoted: false, reason: verificationB.reason };
    const faultA = verificationA.result?.failure;
    const faultB = verificationB.result?.failure;
    if (!faultA || !faultB || !matchesTarget(verificationB.result) || faultA.tick !== faultB.tick ||
        canonicalHash(faultA.signature) !== canonicalHash(faultB.signature) ||
        canonicalHash(faultA.state) !== canonicalHash(faultB.state)) return { promoted: false };

    const finalStop = deadlineOrCancellation();
    if (finalStop) return { promoted: false, reason: finalStop };
    const verifiedPackage = createProbePackage(adapter, makeRequest(commands.length), verificationA.result!);
    const packageStop = deadlineOrCancellation();
    if (packageStop) return { promoted: false, reason: packageStop };
    bestCommands = [...commands];
    bestPackage = verifiedPackage;
    bestCandidateVerified = true;
    return { promoted: true };
  };

  const initial = execute(bestCommands);
  if (initial.reason) return report(initial.reason === 'cancelled' ? 'cancelled' : 'budget-exhausted', `initial reproduction stopped by ${initial.reason}`);
  if (!matchesTarget(initial.result)) return report('not-reproducible', 'strict replay did not reach the same first failure signature');

  let granularity = 2;
  let changed = true;
  while (changed) {
    changed = false;
    while (bestCommands.length >= 2) {
      const stop = stopBeforeRun();
      if (stop) return finishStopped(stop);
      const chunkSize = Math.ceil(bestCommands.length / granularity);
      let reduced = false;
      for (let startIndex = 0; startIndex < bestCommands.length; startIndex += chunkSize) {
        const candidateStop = stopBeforeRun();
        if (candidateStop) return finishStopped(candidateStop);
        let candidate: DataDTO[];
        try { candidate = normalizeCandidate(bestCommands.filter((_command, index) => index < startIndex || index >= startIndex + chunkSize)); }
        catch { continue; }
        const reserve = reserveCandidateBudget(candidate);
        if (reserve) return finishStopped(reserve);
        const trial = execute(candidate);
        if (trial.reason) return finishStopped(trial.reason);
        const verification = trial.result ? verifyAndPromote(candidate, trial.result) : { promoted: false };
        if (verification.reason) return finishStopped(verification.reason);
        if (verification.promoted) {
          granularity = Math.max(2, granularity - 1); changed = true; reduced = true; break;
        }
      }
      if (reduced) continue;
      if (granularity >= bestCommands.length) break;
      granularity = Math.min(bestCommands.length, granularity * 2);
    }

    if (strategy.neutralCommand) {
      for (let index = 0; index < bestCommands.length; index++) {
        const stop = stopBeforeRun();
        if (stop) return finishStopped(stop);
        const original = bestCommands[index];
        if (original === undefined) continue;
        let neutral: DataDTO;
        try { neutral = cloneData(adapter.encodeCommand(strategy.neutralCommand({ index, original: cloneData(original) }))); }
        catch { continue; }
        if (canonicalHash(neutral) === canonicalHash(original)) continue;
        let candidate: DataDTO[];
        try { candidate = normalizeCandidate(bestCommands.map((command, at) => at === index ? neutral : command)); }
        catch { continue; }
        const reserve = reserveCandidateBudget(candidate);
        if (reserve) return finishStopped(reserve);
        const trial = execute(candidate);
        if (trial.reason) return finishStopped(trial.reason);
        const verification = trial.result ? verifyAndPromote(candidate, trial.result) : { promoted: false };
        if (verification.reason) return finishStopped(verification.reason);
        if (verification.promoted) changed = true;
      }
    }
  }

  const status: MinimizeResult['status'] = bestCandidateVerified && bestCommands.length < originalLength ? 'reduced' : 'unchanged';
  return report(status, status === 'reduced' ? 'two independent candidate replays matched first-failure signature, tick, and complete failure state' : 'no shorter doubly verified command sequence was found');

  function finishStopped(reason: StopReason): MinimizeResult {
    return report(reason === 'cancelled' ? 'cancelled' : 'budget-exhausted', reason === 'cancelled' ? 'cancel requested; returned the last doubly verified candidate or original package' : 'minimization budget exhausted; returned the last doubly verified candidate or original package');
  }
  function report(status: MinimizeResult['status'], reason: string): MinimizeResult {
    return { status, originalLength, reducedLength: bestPackage?.encoded.commands.length ?? originalLength, attempts, replayVerifications, elapsedMilliseconds: elapsed(), stopReason: reason, ...(bestPackage ? { package: bestPackage } : {}) };
  }
  function deadlineOrCancellation(): StopReason | undefined {
    if (budget.isCancelled?.()) return 'cancelled';
    if (elapsed() >= budget.maxMilliseconds) return 'budget';
    return undefined;
  }
}

export async function minimizeFailureAsync<State>(adapter: ProbeAdapter<State>, source: ProbePackage, strategy: CommandStrategy<State>, budget: MinimizeBudget, options: { yield?: () => Promise<void> } = {}): Promise<MinimizeResult> {
  const yieldTurn = options.yield ?? budget.yieldControl ?? (() => Promise.resolve());
  const started = budget.clock?.();
  const originalCommands = source.encoded.commands.map(cloneData);
  const originalLength = originalCommands.length;
  let attempts = 0; let replayVerifications = 0; let ticksUsed = 0;
  let bestCommands = [...originalCommands];
  // The original artifact is a safe fallback. A smaller candidate is promoted
  // only after two independent verifier runs agree on the complete failure.
  let bestPackage: ProbePackage | undefined = source;
  let bestCandidateVerified = false;
  const elapsed = (): number => {
    const now = budget.clock?.();
    return typeof now === 'number' && Number.isFinite(now) ? Math.max(0, now - (started as number)) : Number.POSITIVE_INFINITY;
  };
  if (typeof budget.clock !== 'function' || !Number.isFinite(started)) return report('budget-exhausted', 'budget.clock must be injected and return a finite starting value');
  if (!validBudget(budget)) return report('budget-exhausted', 'invalid minimization budget');
  const targetSignature = source.outcome.failure?.signature;
  if (source.outcome.status !== 'failed' || !targetSignature || source.outcome.invalidStart) return report('not-reproducible', 'source package has no motion-time first failure to minimize');

  const makeRequest = (commandCount: number): RunRequest => ({ caseId: source.case.caseId, seed: source.case.seed, maxTicks: commandCount, world: adapter.decodeWorld(cloneData(source.encoded.world)), config: adapter.decodeConfig(cloneData(source.encoded.config)), start: adapter.decodeStart(cloneData(source.encoded.start)) });
  const normalizeCandidate = (commands: DataDTO[]): DataDTO[] => {
    const output = strategy.normalizeCommands?.(commands.map(cloneData)) ?? commands;
    if (!Array.isArray(output) || output.length !== commands.length) throw new TypeError('normalizeCommands must preserve candidate length');
    return output.map((command) => {
      assertDataDTO(command);
      const normalized = cloneData(adapter.encodeCommand(adapter.decodeCommand(cloneData(command))));
      if (canonicalHash(normalized) !== canonicalHash(command)) throw new TypeError('normalized command does not round-trip through the adapter codec');
      return normalized;
    });
  };
  const stopWithinRun = (): StopReason | undefined => {
    if (budget.isCancelled?.()) return 'cancelled';
    if (ticksUsed >= budget.maxTicks || elapsed() >= budget.maxMilliseconds) return 'budget';
    return undefined;
  };
  const stopBeforeRun = (): StopReason | undefined => stopWithinRun() ?? (attempts >= budget.maxRuns ? 'budget' : undefined);
  const execute = async (commands: DataDTO[]): Promise<CandidateRun> => {
    await yieldTurn();
    const beforeStart = stopBeforeRun();
    if (beforeStart) return { reason: beforeStart };
    attempts++;
    const request = makeRequest(commands.length); let index = 0;
    const candidateStrategy: CommandStrategy<State> = { nextCommand() { const item = commands[index++]; if (item === undefined) throw new Error('minimizer command stream ended early'); return adapter.decodeCommand(cloneData(item)); } };
    let controller;
    try { controller = createRunController(adapter, request, candidateStrategy); }
    catch { return { reason: 'budget' }; }
    while (controller.result.status === 'running') {
      await yieldTurn();
      const stop = stopWithinRun();
      if (stop) { controller.cancel(stop === 'cancelled' ? 'cancelled during minimization' : 'minimization budget exhausted'); return { result: controller.result, reason: stop }; }
      const before = controller.result.ticksExecuted;
      const result = controller.advance(1);
      ticksUsed += result.ticksExecuted - before;
      if (elapsed() >= budget.maxMilliseconds) { controller.cancel('minimization time budget exhausted'); return { result: controller.result, reason: 'budget' }; }
      if (result.status === 'running' && ticksUsed >= budget.maxTicks) {
        controller.cancel('minimization tick budget exhausted');
        return { result: controller.result, reason: 'budget' };
      }
    }
    return { result: controller.result };
  };
  const matchesTarget = (result: CaseResult | undefined): boolean => !!result?.failure && canonicalHash(result.failure.signature) === canonicalHash(targetSignature);
  const reserveCandidateBudget = (commands: DataDTO[]): StopReason | undefined => {
    const stop = stopBeforeRun();
    if (stop) return stop;
    if (attempts + 3 > budget.maxRuns || ticksUsed + commands.length * 3 > budget.maxTicks) return 'budget';
    return undefined;
  };
  const verifyAndPromote = async (commands: DataDTO[], trial: CaseResult): Promise<{ promoted: boolean; reason?: StopReason }> => {
    if (!matchesTarget(trial)) return { promoted: false };
    const beforeA = attempts;
    const verificationA = await execute(commands);
    replayVerifications += attempts - beforeA;
    if (verificationA.reason) return { promoted: false, reason: verificationA.reason };
    if (!matchesTarget(verificationA.result) || !verificationA.result?.failure) return { promoted: false };

    const beforeB = attempts;
    const verificationB = await execute(commands);
    replayVerifications += attempts - beforeB;
    if (verificationB.reason) return { promoted: false, reason: verificationB.reason };
    const faultA = verificationA.result?.failure;
    const faultB = verificationB.result?.failure;
    if (!faultA || !faultB || !matchesTarget(verificationB.result) || faultA.tick !== faultB.tick ||
        canonicalHash(faultA.signature) !== canonicalHash(faultB.signature) || canonicalHash(faultA.state) !== canonicalHash(faultB.state)) return { promoted: false };

    const finalStop = deadlineOrCancellation();
    if (finalStop) return { promoted: false, reason: finalStop };
    const verifiedPackage = createProbePackage(adapter, makeRequest(commands.length), verificationA.result!);
    const packageStop = deadlineOrCancellation();
    if (packageStop) return { promoted: false, reason: packageStop };
    bestCommands = [...commands];
    bestPackage = verifiedPackage;
    bestCandidateVerified = true;
    return { promoted: true };
  };

  const initial = await execute(bestCommands);
  if (initial.reason) return report(initial.reason === 'cancelled' ? 'cancelled' : 'budget-exhausted', `initial reproduction stopped by ${initial.reason}`);
  if (!matchesTarget(initial.result)) return report('not-reproducible', 'strict replay did not reach the same first failure signature');

  let granularity = 2; let changed = true;
  while (changed) {
    changed = false;
    while (bestCommands.length >= 2) {
      const stop = stopBeforeRun();
      if (stop) return finishStopped(stop);
      const chunkSize = Math.ceil(bestCommands.length / granularity); let reduced = false;
      for (let startIndex = 0; startIndex < bestCommands.length; startIndex += chunkSize) {
        const candidateStop = stopBeforeRun();
        if (candidateStop) return finishStopped(candidateStop);
        let candidate: DataDTO[];
        try { candidate = normalizeCandidate(bestCommands.filter((_command, index) => index < startIndex || index >= startIndex + chunkSize)); }
        catch { continue; }
        const reserve = reserveCandidateBudget(candidate);
        if (reserve) return finishStopped(reserve);
        const trial = await execute(candidate);
        if (trial.reason) return finishStopped(trial.reason);
        const verification = trial.result ? await verifyAndPromote(candidate, trial.result) : { promoted: false };
        if (verification.reason) return finishStopped(verification.reason);
        if (verification.promoted) { granularity = Math.max(2, granularity - 1); changed = true; reduced = true; break; }
      }
      if (reduced) continue;
      if (granularity >= bestCommands.length) break;
      granularity = Math.min(bestCommands.length, granularity * 2);
    }
    if (strategy.neutralCommand) {
      for (let index = 0; index < bestCommands.length; index++) {
        const stop = stopBeforeRun();
        if (stop) return finishStopped(stop);
        const original = bestCommands[index]; if (original === undefined) continue;
        let neutral: DataDTO;
        try { neutral = cloneData(adapter.encodeCommand(strategy.neutralCommand({ index, original: cloneData(original) }))); }
        catch { continue; }
        if (canonicalHash(neutral) === canonicalHash(original)) continue;
        let candidate: DataDTO[];
        try { candidate = normalizeCandidate(bestCommands.map((command, at) => at === index ? neutral : command)); }
        catch { continue; }
        const reserve = reserveCandidateBudget(candidate);
        if (reserve) return finishStopped(reserve);
        const trial = await execute(candidate);
        if (trial.reason) return finishStopped(trial.reason);
        const verification = trial.result ? await verifyAndPromote(candidate, trial.result) : { promoted: false };
        if (verification.reason) return finishStopped(verification.reason);
        if (verification.promoted) changed = true;
      }
    }
  }

  const status: MinimizeResult['status'] = bestCandidateVerified && bestCommands.length < originalLength ? 'reduced' : 'unchanged';
  return report(status, status === 'reduced' ? 'two independent candidate replays matched first-failure signature, tick, and complete failure state' : 'no shorter doubly verified command sequence was found');

  function finishStopped(reason: StopReason): MinimizeResult {
    return report(reason === 'cancelled' ? 'cancelled' : 'budget-exhausted', reason === 'cancelled' ? 'cancel requested; returned the last doubly verified candidate or original package' : 'minimization budget exhausted; returned the last doubly verified candidate or original package');
  }
  function report(status: MinimizeResult['status'], stopReason: string): MinimizeResult { return { status, originalLength, reducedLength: bestPackage?.encoded.commands.length ?? originalLength, attempts, replayVerifications, elapsedMilliseconds: elapsed(), stopReason, ...(bestPackage ? { package: bestPackage } : {}) }; }
  function deadlineOrCancellation(): StopReason | undefined {
    if (budget.isCancelled?.()) return 'cancelled';
    if (elapsed() >= budget.maxMilliseconds) return 'budget';
    return undefined;
  }
}

function validBudget(budget: MinimizeBudget): boolean {
  return Number.isSafeInteger(budget.maxRuns) && budget.maxRuns >= 1 &&
    Number.isSafeInteger(budget.maxTicks) && budget.maxTicks >= 0 &&
    Number.isFinite(budget.maxMilliseconds) && budget.maxMilliseconds >= 0;
}

function cloneData<T extends DataDTO>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
