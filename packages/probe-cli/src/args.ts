import { CliInputError, type ParsedArgs, type ProbeCommand, type ReportFormat } from './types.js';

const commands = new Set<ProbeCommand>(['run', 'replay', 'regress', 'minimize', 'check', 'help']);
const scenarios = new Set(['healthy', 'drop', 'penetration', 'non-finite']);
const MAX_TOTAL_RUN_TICKS = 1_000_000;
export const MAX_CASE_TICKS = 3600;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const leadingHelp = argv[0] === '--help' || argv[0] === '-h';
  const commandName = leadingHelp ? 'help' : argv[0] ?? 'help';
  if (!commands.has(commandName as ProbeCommand)) {
    throw new CliInputError(`Unknown command "${commandName}". Use "probe help".`);
  }

  const result: ParsedArgs = {
    command: commandName as ProbeCommand,
    help: commandName === 'help',
    seed: '1',
    probes: 16,
    ticks: 3600,
    concurrency: 4,
    outputDir: 'probe-output',
    format: 'both',
    mode: commandName === 'regress' ? 'regress' : 'strict',
    maxRuns: 500,
    maxMinimizeTicks: 3600,
    maxMilliseconds: 10_000,
    maxBytes: 32 * 1024 * 1024,
    maxFaults: 100,
    maxOutputBytes: 128 * 1024 * 1024,
    allowWorldChange: false,
    allowConfigChange: false,
    saveAll: false
  };

  let positionalInput: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      result.command = 'help';
      continue;
    }
    if (arg === '--allow-world-change') {
      result.allowWorldChange = true;
      continue;
    }
    if (arg === '--allow-config-change') {
      result.allowConfigChange = true;
      continue;
    }
    if (arg === '--save-all') {
      result.saveAll = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      if (positionalInput !== undefined) throw new CliInputError(`Unexpected positional argument "${arg}".`);
      positionalInput = arg;
      continue;
    }

    const [flag, inlineValue] = splitFlag(arg);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new CliInputError(`${flag} requires a value.`);
    switch (flag) {
      case '--adapter': result.adapter = value; break;
      case '--map': result.map = value; break;
      case '--scenario':
        if (!scenarios.has(value)) throw new CliInputError(`Unsupported scenario "${value}". Choose healthy, drop, penetration, or non-finite.`);
        result.scenario = value;
        break;
      case '--target-scenario': result.targetScenario = value; break;
      case '--seed': result.seed = value; break;
      case '--probes': result.probes = parsePositiveInt(flag, value, 1, 10_000); break;
      case '--ticks': result.ticks = parsePositiveInt(flag, value, 1, MAX_CASE_TICKS); break;
      case '--concurrency': result.concurrency = parsePositiveInt(flag, value, 1, 32); break;
      case '--output':
      case '--output-dir': result.outputDir = value; break;
      case '--format':
      case '--report': result.format = parseReportFormat(value); break;
      case '--file':
      case '--input': result.input = value; break;
      case '--mode':
        if (value !== 'strict' && value !== 'regress') throw new CliInputError('--mode must be strict or regress.');
        result.mode = value;
        break;
      case '--max-runs': result.maxRuns = parsePositiveInt(flag, value, 1, 1_000_000); break;
      case '--max-ticks': result.maxMinimizeTicks = parsePositiveInt(flag, value, 1, 1_000_000); break;
      case '--max-ms': result.maxMilliseconds = parsePositiveInt(flag, value, 1, 86_400_000); break;
      case '--max-bytes': result.maxBytes = parsePositiveInt(flag, value, 1, 128 * 1024 * 1024); break;
      case '--max-faults': result.maxFaults = parseNonnegativeInt(flag, value, 0, 10_000); break;
      case '--max-output-bytes': result.maxOutputBytes = parsePositiveInt(flag, value, 1, 1024 * 1024 * 1024); break;
      case '--budget': parseBudget(value, result); break;
      case '--fixture-out': result.fixtureOut = value; break;
      default: throw new CliInputError(`Unknown option "${flag}".`);
    }
  }

  if (positionalInput !== undefined) {
    if (result.input !== undefined) throw new CliInputError('Input was provided both positionally and with --file.');
    result.input = positionalInput;
  }
  if (result.help) return result;
  if (result.command === 'run' && result.probes * result.ticks > MAX_TOTAL_RUN_TICKS) {
    throw new CliInputError(`--probes × --ticks exceeds the ${MAX_TOTAL_RUN_TICKS}-tick total run budget.`);
  }
  if (['replay', 'regress', 'minimize', 'check'].includes(result.command) && result.input === undefined) {
    throw new CliInputError(`${result.command} requires a package or fixture path (positional or --file).`);
  }
  if (result.command === 'regress' && result.targetScenario === undefined) {
    throw new CliInputError('regress requires an explicit --target-scenario (for example: healthy).');
  }
  if (result.command === 'replay' && result.mode !== 'strict') throw new CliInputError('Use the "regress" command for healthy-target checks.');
  if (result.fixtureOut !== undefined && result.command !== 'regress') throw new CliInputError('--fixture-out is only valid with regress.');
  return result;
}

export function helpText(): string {
  return [
    'ProbeLab deterministic simulation tools',
    '',
    'Commands:',
    '  probe run       run deterministic probes and save a report',
    '  probe replay    strictly replay a .probe.json package',
    '  probe regress   test a package against a healthy target scenario',
    '  probe minimize  reduce a reproducible failure package',
    '  probe check     validate package integrity and adapter compatibility',
    '  probe help      show this help',
    '',
    'Common options:',
    '  --adapter ID                choose a trusted registered adapter',
    '  --map ID                    choose a map/world key',
    '  --scenario healthy|drop|penetration|non-finite',
    '  --seed VALUE --probes N --ticks N (max 3600 per case) --concurrency N',
    '  --output DIR --format json|md|both',
    '  --max-faults N --max-output-bytes N saved packet evidence budget',
    '  --file PATH                 input package/fixture (or positional path)',
    '  --budget runs=N,ticks=N,ms=N minimize budget',
    '  --target-scenario healthy   explicit regression target scenario',
    '  --allow-world-change --allow-config-change',
    '',
    'Exit codes: 0 success, 1 detected fault/divergence, 2 invalid input or incompatible adapter, 130 interrupted.'
  ].join('\n');
}

function splitFlag(arg: string): [string, string | undefined] {
  const equals = arg.indexOf('=');
  return equals < 0 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)];
}

function parsePositiveInt(flag: string, value: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(value)) throw new CliInputError(`${flag} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliInputError(`${flag} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseNonnegativeInt(flag: string, value: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(value)) throw new CliInputError(`${flag} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliInputError(`${flag} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseReportFormat(value: string): ReportFormat {
  if (value === 'json' || value === 'md' || value === 'both') return value;
  throw new CliInputError('--format must be json, md, or both.');
}

function parseBudget(value: string, result: ParsedArgs): void {
  const fields = value.split(/[;,]/).filter(Boolean);
  if (fields.length === 0) throw new CliInputError('--budget must use runs=N,ticks=N,ms=N.');
  const seen = new Set<string>();
  for (const field of fields) {
    const match = /^(runs|ticks|ms)=([0-9]+)$/.exec(field.trim());
    if (!match) throw new CliInputError(`Invalid --budget field "${field}"; use runs=N,ticks=N,ms=N.`);
    const key = match[1];
    const amount = match[2];
    if (key === undefined || amount === undefined || seen.has(key)) throw new CliInputError(`Duplicate --budget field "${key ?? ''}".`);
    seen.add(key);
    const max = key === 'ms' ? 86_400_000 : 1_000_000;
    const parsed = parsePositiveInt(`--budget ${key}`, amount, 1, max);
    if (key === 'runs') result.maxRuns = parsed;
    else if (key === 'ticks') result.maxMinimizeTicks = parsed;
    else result.maxMilliseconds = parsed;
  }
}
