import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { registry } from '@probelab/sandbox';
import { createNodeIO, main, type ProbeCliIO } from '../src/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = resolve(packageRoot, 'dist/bin.js');
interface Invocation { status: number | null; stdout: string; stderr: string }

test('bin emits one JSON object and actual help/argument exit codes', () => {
  const help = invoke(['help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.equal(JSON.parse(help.stdout).command, 'help');
  assert.equal(help.stdout.trimStart().startsWith('{'), true);

  const invalid = invoke(['run', '--probes', '0']);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).exitCode, 2);
  assert.match(invalid.stderr, /--probes must be between/);

  const unsupportedTicks = invoke(['run', '--ticks', '3601']);
  assert.equal(unsupportedTicks.status, 2);
  assert.equal(JSON.parse(unsupportedTicks.stdout).exitCode, 2);
  assert.match(unsupportedTicks.stderr, /--ticks must be between 1 and 3600/);
});

test('sandbox run, packet check, strict replay and healthy regression use the real bin', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'probelab-cli-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  const healthyDir = resolve(directory, 'healthy');
  const healthy = invoke(['run', '--seed', 'exit-test', '--probes', '2', '--ticks', '20', '--concurrency', '2', '--scenario', 'healthy', '--output', healthyDir, '--format', 'both']);
  assert.equal(healthy.status, 0, healthy.stderr);
  const healthyReport = JSON.parse(healthy.stdout);
  assert.equal(healthyReport.summary.casesCompleted, 2);
  assert.deepEqual(healthyReport.cases.map((item: { caseId: string }) => item.caseId), ['probe-0001', 'probe-0002']);
  assert.equal(healthyReport.cases[0].coverage.capacity, 96);
  assert.equal(healthyReport.cases[0].coverage.visited > 0, true);
  assert.equal(healthyReport.coverage.casesWithCapacity, 2);
  assert.equal((await readFile(resolve(healthyDir, 'report.json'), 'utf8')).includes('"command": "run"'), true);
  const serialHealthy = invoke(['run', '--seed', 'exit-test', '--probes', '2', '--ticks', '20', '--concurrency', '1', '--scenario', 'healthy', '--output', resolve(directory, 'healthy-serial'), '--format', 'json']);
  assert.equal(serialHealthy.status, 0, serialHealthy.stderr);
  assert.deepEqual(JSON.parse(serialHealthy.stdout).cases, healthyReport.cases);

  const faultDir = resolve(directory, 'fault');
  const fault = invoke(['run', '--seed', 'fault-exit-test', '--probes', '1', '--ticks', '240', '--concurrency', '1', '--scenario', 'drop', '--output', faultDir, '--format', 'json']);
  assert.equal(fault.status, 1, fault.stderr);
  const faultReport = JSON.parse(fault.stdout);
  assert.equal(faultReport.summary.failures, 1);
  const packetPath = resolve(faultDir, 'cases', 'probe-0001.probe.json');

  const limitedEvidence = invoke([
    'run', '--seed', 'fault-exit-test', '--probes', '1', '--ticks', '240', '--scenario', 'drop',
    '--max-faults', '0', '--output', resolve(directory, 'limited-evidence'), '--format', 'json'
  ]);
  assert.equal(limitedEvidence.status, 1, limitedEvidence.stderr);
  assert.equal(JSON.parse(limitedEvidence.stdout).summary.savedPackages, 0);
  assert.match(JSON.parse(limitedEvidence.stdout).cases[0].packageOmittedReason, /max-faults limit/);

  const sizeCappedEvidence = invoke([
    'run', '--seed', 'fault-exit-test', '--probes', '1', '--ticks', '240', '--scenario', 'drop',
    '--max-output-bytes', '1', '--output', resolve(directory, 'size-capped-evidence'), '--format', 'json'
  ]);
  assert.equal(sizeCappedEvidence.status, 1, sizeCappedEvidence.stderr);
  assert.equal(JSON.parse(sizeCappedEvidence.stdout).summary.savedPackages, 0);
  assert.match(JSON.parse(sizeCappedEvidence.stdout).cases[0].packageOmittedReason, /byte limit/);

  const checked = invoke(['check', packetPath, '--output', resolve(directory, 'check'), '--format', 'json']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).result.compatible, true);
  const bounded = invoke(['check', packetPath, '--max-bytes', '1', '--output', resolve(directory, 'bounded'), '--format', 'json']);
  assert.equal(bounded.status, 2);
  assert.match(JSON.parse(bounded.stdout).error.message, /size limit/);
  const tamperedPacket = JSON.parse(await readFile(packetPath, 'utf8'));
  tamperedPacket.integrity.contentHash = '0'.repeat(64);
  const tamperedPath = resolve(directory, 'tampered.probe.json');
  await writeFile(tamperedPath, JSON.stringify(tamperedPacket), 'utf8');
  const tamperedCheck = invoke(['check', tamperedPath, '--output', resolve(directory, 'tampered-check'), '--format', 'json']);
  assert.equal(tamperedCheck.status, 2);

  const strictReplay = invoke(['replay', packetPath, '--output', resolve(directory, 'replay'), '--format', 'json']);
  assert.equal(strictReplay.status, 0, strictReplay.stderr);
  assert.equal(JSON.parse(strictReplay.stdout).result.status, 'verified-failure');

  const stillFaulty = invoke([
    'regress', packetPath,
    '--target-scenario', 'drop',
    '--adapter', 'sandbox',
    '--output', resolve(directory, 'still-faulty'),
    '--format', 'json'
  ]);
  assert.equal(stillFaulty.status, 1, stillFaulty.stderr);
  assert.equal(JSON.parse(stillFaulty.stdout).result.status, 'diverged');

  const minimized = invoke([
    'minimize', packetPath,
    '--scenario', 'drop',
    '--budget', 'runs=2,ticks=240,ms=10000',
    '--output', resolve(directory, 'minimize'),
    '--format', 'json'
  ]);
  assert.notEqual(minimized.status, 2, minimized.stderr);
  assert.deepEqual(JSON.parse(minimized.stdout).config.budgets, { runs: 2, ticks: 240, milliseconds: 10_000 });

  const fixturePath = resolve(directory, 'drop-regression.json');
  const regression = invoke([
    'regress', packetPath,
    '--target-scenario', 'healthy',
    '--adapter', 'sandbox-fixed',
    '--allow-world-change',
    '--allow-config-change',
    '--fixture-out', fixturePath,
    '--output', resolve(directory, 'regress'),
    '--format', 'both'
  ]);
  assert.equal(regression.status, 0, regression.stderr);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixture.expected, 'healthy');
  assert.equal(fixture.source.outcome.status, 'failed');
  assert.equal(fixture.target.compatibilityPolicy.world, 'declared-change-allowed');

  const fixtureRegression = invoke([
    'regress', fixturePath,
    '--target-scenario', 'healthy',
    '--adapter', 'sandbox-fixed',
    '--allow-world-change',
    '--allow-config-change',
    '--output', resolve(directory, 'fixture-regress'),
    '--format', 'json'
  ]);
  assert.equal(fixtureRegression.status, 0, fixtureRegression.stderr);

  const runIO = interruptingIO();
  const cancelledRun = await main([
    'run', '--probes', '10', '--ticks', '3600', '--concurrency', '1', '--scenario', 'healthy',
    '--output', resolve(directory, 'cancelled-run'), '--format', 'json'
  ], registry, runIO.io);
  assert.equal(cancelledRun.exitCode, 130);
  const cancelledReport = JSON.parse(runIO.output());
  assert.equal(cancelledReport.exitCode, 130);
  assert.equal(cancelledReport.status, 'incomplete');
  assert.equal(cancelledReport.summary.savedPackages, 1);
  const cancelledPacket = JSON.parse(await readFile(resolve(directory, 'cancelled-run', 'cases', 'probe-0001.probe.json'), 'utf8'));
  assert.equal(cancelledPacket.outcome.status, 'incomplete');

  const minimizeIO = interruptingIO();
  const cancelledMinimize = await main([
    'minimize', packetPath, '--scenario', 'drop', '--budget', 'runs=10000,ticks=100000,ms=60000',
    '--output', resolve(directory, 'cancelled-minimize'), '--format', 'json'
  ], registry, minimizeIO.io);
  assert.equal(cancelledMinimize.exitCode, 130);
  assert.equal(JSON.parse(minimizeIO.output()).exitCode, 130);
});

test('sandbox non-finite and penetration injections are captured as signed faults', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'probelab-cli-nan-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  for (const scenario of ['non-finite', 'penetration'] as const) {
    const output = resolve(directory, scenario);
    const run = invoke(['run', '--probes', '1', '--ticks', '120', '--scenario', scenario, '--output', output, '--format', 'json']);
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    const packet = JSON.parse(await readFile(resolve(output, 'cases', 'probe-0001.probe.json'), 'utf8'));
    assert.equal(report.cases[0].fault.kind, scenario === 'non-finite' ? 'non-finite-state' : 'penetration');
    assert.equal(packet.outcome.failure.kind, scenario === 'non-finite' ? 'non-finite-state' : 'penetration');
    if (scenario === 'non-finite') assert.equal(containsSpecialNumber(packet.outcome.failure.state), true);
  }
});

function invoke(args: string[]): Invocation {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000
  });
}

function containsSpecialNumber(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSpecialNumber);
  const object = value as Record<string, unknown>;
  if (object.$probeNumber === 'NaN' || object.$probeNumber === '+Infinity' || object.$probeNumber === '-Infinity') return true;
  return Object.values(object).some(containsSpecialNumber);
}

function interruptingIO(): { io: ProbeCliIO; output: () => string } {
  const base = createNodeIO();
  let stdout = '';
  return {
    io: {
      ...base,
      stdout(text): void { stdout += text; },
      onInterrupt(handler): () => void {
        const timer = setTimeout(handler, 1);
        return () => clearTimeout(timer);
      }
    },
    output: () => stdout
  };
}
