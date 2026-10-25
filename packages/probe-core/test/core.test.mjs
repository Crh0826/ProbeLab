import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  assertDataDTO, canonicalHash, canonicalJson, createProbePackage, createRandomSource,
  createRunController, deriveCaseSeed, deriveSeed, importProbePackage, minimizeFailure,
  minimizeFailureAsync, replayPackage, runCase, sha256Hex, verifyPackageIntegrity,
} from '../dist/index.js';
import { cloneData, config, descriptor, makeAdapter, makeRequest, sequenceStrategy, start, world } from './fixture.mjs';

let sandboxAdapter;
let sandboxStrategy;
try {
  ({ sandboxAdapter, sandboxStrategy } = await import('../../../examples/probe-sandbox/dist/index.js'));
} catch { /* The core-only test command remains usable before workspace adapters are built. */ }
const dropEvidenceUrl = new URL('../../../reports/probelab/demo/drop/original.probe.json', import.meta.url);

function runCommands(adapter, commands, request = makeRequest()) {
  return runCase(adapter, { ...request, maxTicks: commands.length }, sequenceStrategy(commands));
}

function makePackage(commands, request = makeRequest(), adapter = makeAdapter()) {
  const result = runCommands(adapter, commands, request);
  return { adapter, result, pkg: createProbePackage(adapter, { ...request, maxTicks: commands.length }, result) };
}

function reseal(pkg) {
  const copy = cloneData(pkg);
  delete copy.integrity;
  copy.integrity = { algorithm: 'sha256', contentHash: canonicalHash(copy) };
  return copy;
}

test('canonical SHA-256 and canonical JSON are stable', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canonicalJson({ z: -0, a: [1, true] }), '{"a":[1,true],"z":0}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.throws(() => assertDataDTO({ value: Number.NaN }), /non-finite/);
});

test('A01 healthy floor contact, jump, low-gravity motion, and wall touch do not report a fault', () => {
  const adapter = makeAdapter();
  const result = runCommands(adapter, [
    { kind: 'move', dy: 0 },
    { kind: 'move', dy: 0.7 },
    { kind: 'move', dy: 0.02 },
    { kind: 'wall-touch' },
  ]);
  assert.equal(result.status, 'complete');
  assert.equal(result.failure, undefined);
  assert.equal(result.trace.length, 4);
});

test('A02 each directed fault has a distinct stable category and target', () => {
  const adapter = makeAdapter();
  const out = runCommands(adapter, [{ kind: 'oob' }]);
  assert.equal(out.failure?.kind, 'out-of-bounds');
  assert.equal(out.failure?.signature.target, 'x:positive');
  assert.equal(out.failure?.detail.axis, 'x');

  const penetration = runCommands(adapter, [{ kind: 'penetrate' }]);
  assert.equal(penetration.failure?.kind, 'penetration');
  assert.equal(penetration.failure?.signature.target, 'wall-a');
  assert.equal(penetration.failure?.detail.colliderId, 'wall-a');

  const nonFinite = runCommands(adapter, [{ kind: 'nonfinite' }]);
  assert.equal(nonFinite.failure?.kind, 'non-finite-state');
  assert.equal(nonFinite.failure?.signature.target, '/velocity/1:NaN');
  assert.equal(nonFinite.failure?.detail.path, '/velocity/1');
  assert.equal(nonFinite.failure?.detail.numberType, 'NaN');
});

test('same-tick oracle priority is numeric, bounds, then penetration', () => {
  const adapter = makeAdapter();
  const result = runCommands(adapter, [{ kind: 'multi-fault' }]);
  assert.equal(result.failure?.kind, 'non-finite-state');
  assert.equal(result.failure?.signature.target, '/velocity/1:NaN');
});

test('A03 stores the raw out-of-bounds state and stops before any later recovery command', () => {
  const adapter = makeAdapter();
  const result = runCommands(adapter, [{ kind: 'oob' }, { kind: 'move', dx: -6 }]);
  assert.equal(result.ticksExecuted, 1);
  assert.equal(result.trace.length, 1);
  assert.equal(result.failure?.state.position[0], 6);
  assert.equal(result.trace[0].state.position[0], 6);
});

test('invalid initial penetration is separated from a simulation-discovered penetration', () => {
  const adapter = makeAdapter();
  const result = runCommands(adapter, [], makeRequest({ start: { position: [2.2, 0, 0], velocity: [0, 0, 0] } }));
  assert.equal(result.status, 'failed');
  assert.equal(result.invalidStart?.kind, 'invalid-start');
  assert.equal(result.failure, undefined);
  assert.equal(result.trace.length, 0);
});

test('A04 case streams are independent and repeat by stable seed/case ID', () => {
  const adapter = makeAdapter();
  const cases = Array.from({ length: 16 }, (_, index) => {
    const caseId = `case-${index}`;
    const seed = deriveCaseSeed('root-seed', 'fixture-room', caseId, 'probe-0');
    const request = makeRequest({ caseId, seed, maxTicks: 40 });
    const strategy = () => ({ nextCommand: ({ rng }) => ({ kind: 'move', dx: 0, sample: rng.nextUint32() }) });
    return { caseId, seed, first: runCase(adapter, request, strategy()), repeat: runCase(adapter, request, strategy()) };
  });
  assert.equal(new Set(cases.map((entry) => entry.seed)).size, 16);
  assert.ok(new Set(cases.map((entry) => entry.first.trace[0].command.sample)).size > 1);
  for (const item of cases) {
    assert.deepEqual(item.first.trace.map((tick) => tick.command), item.repeat.trace.map((tick) => tick.command));
    assert.deepEqual(item.first.trace.map((tick) => tick.stateHash), item.repeat.trace.map((tick) => tick.stateHash));
    assert.deepEqual(item.first.failure?.signature, item.repeat.failure?.signature);
  }
});

test('A05 bounded interleaving gives identical per-case traces to serial execution', () => {
  const adapter = makeAdapter();
  const requests = Array.from({ length: 16 }, (_, index) => makeRequest({ caseId: `interleave-${index}`, seed: `seed-${index}`, maxTicks: 10 }));
  const create = (request) => createRunController(adapter, request, { nextCommand: ({ rng }) => ({ kind: 'move', sample: rng.nextUint32() }) });
  const serial = requests.map((request) => { const controller = create(request); controller.advance(10); return controller.result; });
  const parallelLike = requests.map(create);
  let unfinished = true;
  while (unfinished) {
    unfinished = false;
    for (const controller of parallelLike) {
      if (controller.result.status === 'running') { controller.advance(1); unfinished = true; }
    }
  }
  for (let index = 0; index < serial.length; index++) {
    assert.deepEqual(parallelLike[index].result.trace.map((tick) => tick.command), serial[index].trace.map((tick) => tick.command));
    assert.deepEqual(parallelLike[index].result.trace.map((tick) => tick.stateHash), serial[index].trace.map((tick) => tick.stateHash));
  }
});

test('controller pause, resume, single-step, and cancel preserve partial state', () => {
  const adapter = makeAdapter();
  const request = makeRequest({ maxTicks: 8 });
  const controller = createRunController(adapter, request, { nextCommand: () => ({ kind: 'move', dx: 0.1 }) });
  controller.advance(2);
  assert.equal(controller.result.ticksExecuted, 2);
  controller.pause();
  assert.equal(controller.advance(3).ticksExecuted, 2);
  controller.resume();
  controller.advance(1);
  assert.equal(controller.result.ticksExecuted, 3);
  controller.cancel('user stopped');
  assert.equal(controller.result.status, 'cancelled');
  assert.equal(controller.result.cancelReason, 'user stopped');
});

test('adapter input mutation is a simulation error, never a fabricated game fault', () => {
  const adapter = makeAdapter({ adapter: { step: (state) => { state.position[0] = 1; return { state }; } } });
  const result = runCase(adapter, makeRequest({ maxTicks: 1 }), { nextCommand: () => ({ kind: 'move' }) });
  assert.equal(result.status, 'failed');
  assert.ok(result.error.message.length > 0);
  assert.equal(result.failure, undefined);
});

test('A06 package round-trips and strict replay verifies the same first fault', () => {
  const { adapter, pkg } = makePackage([{ kind: 'penetrate' }]);
  assert.deepEqual(pkg.tool, { name: 'ProbeLab', version: '0.1.0' });
  assert.equal(verifyPackageIntegrity(JSON.parse(JSON.stringify(pkg))), undefined);
  const text = JSON.stringify(pkg);
  const imported = importProbePackage(text);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.value.outcome.failure.signature, pkg.outcome.failure.signature);
  const replay = replayPackage(adapter, imported.value, { mode: 'strict' });
  assert.equal(replay.status, 'verified-failure');
  assert.equal(replay.result.failure.tick, 1);
  assert.equal(replay.result.trace[0].stateHash, pkg.outcome.trace[0].stateHash);
});

test('replay validates the package content hash itself and strict mode rejects supplied target changes', () => {
  const { adapter, pkg } = makePackage([{ kind: 'penetrate' }]);
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.outcome.trace[0].detail = { changed: true };
  assert.match(verifyPackageIntegrity(tampered), /content hash mismatch/);
  assert.equal(replayPackage(adapter, tampered, { mode: 'strict' }).status, 'incompatible');
  assert.equal(replayPackage(adapter, pkg, { mode: 'strict', targetWorld: { changed: true } }).status, 'incompatible');
  assert.equal(replayPackage(adapter, pkg, { mode: 'strict', targetConfig: { changed: true } }).status, 'incompatible');
});

test('coverage updates in place across ticks and the strategy sees a live read-only view', () => {
  const adapter = makeAdapter();
  const request = makeRequest({ maxTicks: 3 });
  const seen = [];
  const controller = createRunController(adapter, request, {
    nextCommand(context) {
      seen.push([context.coverage.total, context.coverage.visited, context.coverage.visits['cell-0'] ?? 0]);
      assert.throws(() => { context.coverage.visits.injected = 1; }, /read-only/);
      return { kind: 'move', dx: 0 };
    },
    coverageKey: () => 'cell-0',
  });
  const coverageRef = controller.result.coverage;
  controller.advance(1);
  controller.advance(2);
  assert.deepEqual(seen, [[0, 0, 0], [1, 1, 1], [2, 1, 2]]);
  assert.equal(controller.result.coverage, coverageRef);
  assert.equal(controller.result.coverage.visited, 1);
  assert.equal(controller.result.coverage.capacity, 16);
  assert.equal(controller.result.coverage.ratio, 1 / 16);
  assert.equal(controller.result.coverage.visits['cell-0'], 3);
});

test('strict replay normalizes debug-scene collider order exactly like package creation', () => {
  const adapter = makeAdapter();
  const unsortedWorld = cloneData(world);
  unsortedWorld.colliders = [
    { id: 'z-wall', bounds: { min: [4, 0, -1], max: [4.5, 3, 1] }, solid: true },
    ...unsortedWorld.colliders,
  ];
  const request = makeRequest({ world: unsortedWorld });
  const result = runCommands(adapter, [{ kind: 'penetrate' }], request);
  const pkg = createProbePackage(adapter, { ...request, maxTicks: 1 }, result);
  assert.deepEqual(pkg.encoded.debugWorld.colliders.map((collider) => collider.id), ['wall-a', 'z-wall']);
  assert.equal(replayPackage(adapter, pkg, { mode: 'strict' }).status, 'verified-failure');
});

test('healthy package import and strict replay preserve the completed outcome', () => {
  const { adapter, pkg } = makePackage([{ kind: 'move', dy: 0.2 }, { kind: 'move', dy: 0 }]);
  assert.equal(pkg.outcome.status, 'healthy');
  const imported = importProbePackage(JSON.stringify(pkg));
  assert.equal(imported.ok, true);
  const replay = replayPackage(adapter, imported.value, { mode: 'strict' });
  assert.equal(replay.status, 'healthy');
  assert.equal(replay.ticksExecuted, 2);
});

test('A07 strict replay rejects incompatible builds, and package hashes reject changed world data', () => {
  const { adapter, pkg } = makePackage([{ kind: 'penetrate' }]);
  const incompatible = makeAdapter({ descriptor: { buildId: 'new-build' } });
  assert.equal(replayPackage(incompatible, pkg, { mode: 'strict' }).status, 'incompatible');

  const changed = cloneData(pkg);
  changed.encoded.world.bounds.max[0] = 99;
  const tampered = reseal(changed);
  const imported = importProbePackage(JSON.stringify(tampered));
  assert.equal(imported.ok, false);
  assert.match(imported.message, /world\/config hash/);
});

test('explicit healthy regression accepts a new simulation without comparing old state hashes', () => {
  const baseAdapter = makeAdapter();
  const baseRequest = makeRequest({ maxTicks: 2 });
  const baseResult = runCommands(baseAdapter, [{ kind: 'move', dx: 0 }, { kind: 'move', dx: 0 }], baseRequest);
  const pkg = createProbePackage(baseAdapter, { ...baseRequest, maxTicks: 2 }, baseResult);
  const targetAdapter = makeAdapter({
    descriptor: { simulationVersion: 'fixture-v2', implementationHash: 'fixture-hash-v2', buildId: 'target-build' },
    adapter: {
      step: (state) => ({ state: { ...state, position: [...state.position.slice(0, 1), state.position[1] + 0.01, state.position[2]], velocity: [...state.velocity] } }),
    },
  });
  assert.equal(replayPackage(targetAdapter, pkg, { mode: 'strict' }).status, 'incompatible');
  const targetConfig = { oracle: { ...cloneData(config.oracle), tolerance: [0.05, 0.05, 0.05] } };
  const regression = replayPackage(targetAdapter, pkg, { mode: 'regress', targetConfig });
  assert.equal(regression.status, 'healthy');
  assert.ok(regression.targetDifferences.some((difference) => difference.startsWith('config hash')));
  assert.ok(regression.targetDifferences.some((difference) => difference.startsWith('oracle config')));
});

test('A08 ddmin and neutral replacement find a shorter replay, verified twice', () => {
  const commands = [{ kind: 'move', dx: 0 }, { kind: 'move', dy: 0 }, { kind: 'penetrate' }];
  const { adapter, pkg } = makePackage(commands);
  const policy = sequenceStrategy(commands);
  let normalizations = 0;
  policy.normalizeCommands = (candidate) => { normalizations++; return candidate.map((command, tick) => ({ ...command, tick })); };
  let now = 0;
  const reduced = minimizeFailure(adapter, pkg, policy, {
    maxRuns: 100, maxTicks: 1000, maxMilliseconds: 10000, clock: () => now++,
  });
  assert.equal(reduced.status, 'reduced');
  assert.ok(reduced.reducedLength < reduced.originalLength);
  assert.ok(reduced.replayVerifications >= 2);
  assert.equal(reduced.package.outcome.failure.signature.target, 'wall-a');
  assert.equal(reduced.package.encoded.commands.length, 1);
  assert.ok(normalizations > 0);
  assert.equal(reduced.package.encoded.commands[0].tick, 0);
});

test('A09 minimizer rejects an earlier different first failure after deleting a required setup action', () => {
  const commands = [{ kind: 'prepare' }, { kind: 'conditional-hit' }];
  const { adapter, pkg } = makePackage(commands);
  let now = 0;
  const reduced = minimizeFailure(adapter, pkg, sequenceStrategy(commands), {
    maxRuns: 100, maxTicks: 1000, maxMilliseconds: 10000, clock: () => now++,
  });
  assert.equal(pkg.outcome.failure.kind, 'penetration');
  assert.equal(reduced.status, 'unchanged');
  assert.equal(reduced.reducedLength, commands.length);
  assert.equal(reduced.package.outcome.failure.signature.target, 'wall-a');
});

test('real drop package budget exhaustion returns only a doubly replayable shorter candidate', { skip: !sandboxAdapter || !existsSync(dropEvidenceUrl) }, async () => {
  const source = JSON.parse(readFileSync(dropEvidenceUrl, 'utf8'));
  let simulationTicks = 0;
  const measuredAdapter = {
    ...sandboxAdapter,
    step(...args) { simulationTicks++; return sandboxAdapter.step(...args); },
  };
  const result = await minimizeFailureAsync(measuredAdapter, source, sandboxStrategy, {
    maxRuns: 220, maxTicks: 50_000, maxMilliseconds: 15_000, clock: () => Date.now(),
  }, { yield: () => new Promise((resolve) => setImmediate(resolve)) });
  assert.ok(result.attempts <= 220);
  assert.ok(simulationTicks <= 50_000);
  assert.ok(result.package);
  assert.equal(result.originalLength, 104);
  if (result.reducedLength < result.originalLength) {
    assert.ok(result.replayVerifications >= 2);
    assert.equal(result.package.encoded.commands.length, result.reducedLength);
  }
  for (let replay = 0; replay < 2; replay++) {
    assert.equal(replayPackage(sandboxAdapter, result.package, { mode: 'strict' }).status, 'verified-failure');
  }
});

test('time budget expiring after a matching single candidate keeps the original package', () => {
  const commands = [{ kind: 'move', dx: 0 }, { kind: 'move', dy: 0 }, { kind: 'penetrate' }];
  const adapter = makeAdapter();
  const request = makeRequest({ maxTicks: commands.length });
  const result = runCommands(adapter, commands, request);
  const source = createProbePackage(adapter, request, result);
  let simulationTicks = 0;
  const measuredAdapter = { ...adapter, step(...args) { simulationTicks++; return adapter.step(...args); } };
  const timeBudget = {
    maxRuns: 20, maxTicks: 1000, maxMilliseconds: 5,
    clock: () => simulationTicks >= 4 ? 5 : 0,
  };
  const minimized = minimizeFailure(measuredAdapter, source, sequenceStrategy(commands), timeBudget);
  assert.equal(minimized.status, 'budget-exhausted');
  assert.equal(minimized.attempts, 2); // Baseline plus one matching, unverified candidate.
  assert.equal(minimized.replayVerifications, 0);
  assert.equal(minimized.reducedLength, commands.length);
  assert.equal(minimized.package, source);
});

test('cancellation after a matching single candidate returns the last verified package', async () => {
  const commands = [{ kind: 'move', dx: 0 }, { kind: 'move', dy: 0 }, { kind: 'penetrate' }];
  const { adapter, pkg } = makePackage(commands);
  let now = 0; let yields = 0; let cancelled = false;
  const result = await minimizeFailureAsync(adapter, pkg, sequenceStrategy(commands), {
    maxRuns: 20, maxTicks: 1000, maxMilliseconds: 10_000,
    clock: () => now++, isCancelled: () => cancelled,
  }, {
    yield: async () => { yields++; if (yields === 7) cancelled = true; },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.attempts, 2); // The shorter candidate matched, but its verifier pair never started.
  assert.equal(result.replayVerifications, 0);
  assert.equal(result.reducedLength, commands.length);
  assert.equal(result.package, pkg);
});

test('A10 non-finite type/path survives export/import; malformed tags and oversized input fail', () => {
  const { pkg } = makePackage([{ kind: 'nonfinite' }]);
  const imported = importProbePackage(JSON.stringify(pkg));
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.value.outcome.failure.state.velocity[1], { $probeNumber: 'NaN' });
  assert.equal(imported.value.outcome.failure.detail.path, '/velocity/1');

  const wrongPath = cloneData(pkg);
  wrongPath.outcome.trace[0].state.phase = { $probeNumber: 'NaN' };
  wrongPath.outcome.trace[0].stateHash = canonicalHash(wrongPath.outcome.trace[0].state);
  wrongPath.outcome.failure.state.phase = { $probeNumber: 'NaN' };
  assert.equal(importProbePackage(JSON.stringify(reseal(wrongPath))).ok, false);

  const badInitial = cloneData(pkg);
  badInitial.encoded.initialState.position[0] = { $probeNumber: 'NaN' };
  assert.equal(importProbePackage(JSON.stringify(reseal(badInitial))).ok, false);

  const badCommand = cloneData(pkg);
  badCommand.encoded.commands[0] = { kind: { $probeNumber: 'NaN', extra: true } };
  badCommand.outcome.trace[0].command = cloneData(badCommand.encoded.commands[0]);
  assert.equal(importProbePackage(JSON.stringify(reseal(badCommand))).ok, false);
  assert.equal(importProbePackage('x'.repeat(100), { maxBytes: 10 }).code, 'IMPORT_SIZE');
  assert.equal(importProbePackage(Uint8Array.from([0x7b, 0xff, 0x7d])).code, 'IMPORT_UTF8');
});

test('A10 imported data strings are not evaluated as code', () => {
  const { pkg } = makePackage([{ kind: 'move', note: 'globalThis.__probe_payload_ran = true' }]);
  delete globalThis.__probe_payload_ran;
  const imported = importProbePackage(JSON.stringify(pkg));
  assert.equal(imported.ok, true);
  assert.equal(globalThis.__probe_payload_ran, undefined);
});

test('non-finite position and height faults keep tagged state but omit invalid geometry', () => {
  const adapter = makeAdapter();
  const cases = [
    { kind: 'position-nan', target: '/position/0:NaN', tag: 'NaN' },
    { kind: 'position-infinity', target: '/position/0:+Infinity', tag: '+Infinity' },
    { kind: 'height-negative-infinity', target: '/height:-Infinity', tag: '-Infinity' },
  ];
  for (const faultCase of cases) {
    const request = makeRequest();
    const result = runCommands(adapter, [{ kind: faultCase.kind }], request);
    assert.equal(result.failure?.kind, 'non-finite-state');
    assert.equal(result.failure?.signature.target, faultCase.target);
    assert.equal(result.trace[0].actorBounds, undefined);
    const pkg = createProbePackage(adapter, { ...request, maxTicks: 1 }, result);
    const imported = importProbePackage(JSON.stringify(pkg));
    assert.equal(imported.ok, true);
    assert.equal(replayPackage(adapter, imported.value, { mode: 'strict' }).status, 'verified-failure');
  }
});

test('A12 cancellation keeps an explicit incomplete package with the captured prefix', () => {
  const adapter = makeAdapter();
  const request = makeRequest({ maxTicks: 10 });
  const controller = createRunController(adapter, request, { nextCommand: () => ({ kind: 'move', dx: 0 }) });
  controller.advance(3);
  controller.cancel('SIGINT');
  const pkg = createProbePackage(adapter, request, controller.result);
  assert.equal(pkg.outcome.status, 'incomplete');
  assert.equal(pkg.outcome.cancelReason, 'SIGINT');
  assert.equal(pkg.outcome.trace.length, 3);
  assert.equal(importProbePackage(JSON.stringify(pkg)).ok, true);
});

test('case seed derivation and independent PRNG instances do not share state', () => {
  const derived = deriveSeed('root', 'map', 'case', 'probe');
  assert.equal(derived, deriveSeed('root', 'map', 'case', 'probe'));
  assert.notEqual(derived, deriveSeed('root', 'map', 'case', 'other-probe'));
  const first = createRandomSource(derived);
  const second = createRandomSource(derived);
  assert.deepEqual(Array.from({ length: 8 }, () => first.nextUint32()), Array.from({ length: 8 }, () => second.nextUint32()));
  first.nextUint32();
  assert.notEqual(first.nextUint32(), second.nextUint32());
});

test('async minimizer yields between candidate batches so cancellation can be delivered', async () => {
  const commands = [{ kind: 'move', dx: 0 }, { kind: 'move', dy: 0 }, { kind: 'penetrate' }];
  const { adapter, pkg } = makePackage(commands);
  let now = 0; let yields = 0; let cancelled = false;
  const reduced = await minimizeFailureAsync(adapter, pkg, sequenceStrategy(commands), {
    maxRuns: 100, maxTicks: 1000, maxMilliseconds: 10000, clock: () => now++, isCancelled: () => cancelled,
  }, {
    yield: async () => { await Promise.resolve(); yields++; if (yields >= 3) cancelled = true; },
  });
  assert.equal(reduced.status, 'cancelled');
  assert.ok(yields >= 3);
  assert.ok(reduced.package);
  assert.equal(reduced.package.outcome.status, 'failed');
});

test('async cancellation before the first rerun still returns the original source package', async () => {
  const commands = [{ kind: 'penetrate' }];
  const { adapter, pkg } = makePackage(commands);
  let now = 0;
  const result = await minimizeFailureAsync(adapter, pkg, sequenceStrategy(commands), {
    maxRuns: 20, maxTicks: 100, maxMilliseconds: 1000, clock: () => now++, isCancelled: () => true,
  }, { yield: async () => {} });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.package, pkg);
});
