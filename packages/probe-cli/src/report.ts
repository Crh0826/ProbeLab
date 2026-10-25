import type { CaseResult } from '@probelab/core';
import type { ProbeCliIO, ReportFormat } from './types.js';

export interface CaseReport {
  caseId: string;
  seed: string;
  status: CaseResult['status'];
  ticksExecuted: number;
  fault?: { kind: string; target: string; tick: number };
  invalidStart?: { reason: string };
  error?: { name: string; message: string; tick: number };
  packagePath?: string;
  packageOmittedReason?: string;
  coverage?: { visited: number; capacity?: number; ratio?: number };
}

export async function writeRunArtifacts(
  io: ProbeCliIO,
  outputDir: string,
  report: Record<string, unknown>,
  cases: Array<{ result: Pick<CaseResult, 'caseId'>; packetJson?: string }>,
  format: ReportFormat
): Promise<{ reportPaths: string[]; casePaths: Record<string, string> }> {
  const caseDir = `${outputDir}/cases`;
  await io.mkdir(outputDir);
  await io.mkdir(caseDir);
  const casePaths: Record<string, string> = {};
  for (const { result, packetJson } of [...cases].sort((a, b) => compareText(a.result.caseId, b.result.caseId))) {
    if (!packetJson) continue;
    const fileName = `${safeFilePart(result.caseId)}.probe.json`;
    const relativePath = `cases/${fileName}`;
    await io.writeFile(`${caseDir}/${fileName}`, `${packetJson}\n`);
    casePaths[result.caseId] = relativePath;
  }

  const reportPaths: string[] = [];
  if (format === 'json' || format === 'both') {
    reportPaths.push('report.json');
  }
  if (format === 'md' || format === 'both') {
    reportPaths.push('report.md');
  }
  const reportWithPaths = { ...report, artifacts: reportPaths };
  if (reportPaths.includes('report.json')) await io.writeFile(`${outputDir}/report.json`, `${stableJson(reportWithPaths)}\n`);
  if (reportPaths.includes('report.md')) await io.writeFile(`${outputDir}/report.md`, renderMarkdown(reportWithPaths));
  return { reportPaths, casePaths };
}

export async function writeSingleReport(
  io: ProbeCliIO,
  outputDir: string,
  report: Record<string, unknown>,
  format: ReportFormat,
  extraFiles: Readonly<Record<string, string>> = {}
): Promise<string[]> {
  await io.mkdir(outputDir);
  const paths: string[] = [];
  if (format === 'json' || format === 'both') {
    paths.push('report.json');
  }
  if (format === 'md' || format === 'both') {
    paths.push('report.md');
  }
  const extras = Object.entries(extraFiles).sort(([a], [b]) => compareText(a, b));
  paths.push(...extras.map(([relative]) => relative));
  const reportWithPaths = { ...report, artifacts: paths };
  if (paths.includes('report.json')) await io.writeFile(`${outputDir}/report.json`, `${stableJson(reportWithPaths)}\n`);
  if (paths.includes('report.md')) await io.writeFile(`${outputDir}/report.md`, renderMarkdown(reportWithPaths));
  for (const [relative, contents] of extras) {
    const path = `${outputDir}/${relative}`;
    const slash = path.lastIndexOf('/');
    if (slash > 0) await io.mkdir(path.slice(0, slash));
    await io.writeFile(path, contents);
  }
  return paths;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, stableReplacer, 2) ?? 'null';
}

export function renderMarkdown(report: Record<string, unknown>): string {
  const command = stringValue(report.command, 'ProbeLab report');
  const status = stringValue(report.status, 'unknown');
  const summary = isRecord(report.summary) ? report.summary : {};
  const lines = [
    `# ProbeLab ${command} report`,
    '',
    `- Status: ${status}`,
    `- Exit code: ${stringValue(report.exitCode, 'unknown')}`,
    `- Adapter: ${nestedString(report.target, 'id')}`,
    `- Map: ${nestedString(report.config, 'map')}`,
    `- Seed: ${nestedString(report.config, 'seed')}`,
    '',
    '## Summary',
    '',
    '| Measure | Value |',
    '| --- | ---: |'
  ];
  for (const key of Object.keys(summary).sort()) {
    lines.push(`| ${escapeCell(key)} | ${escapeCell(formatValue(summary[key]))} |`);
  }
  if (isRecord(report.result)) {
    const resultRows = Object.keys(report.result)
      .filter((key) => !['trace', 'package', 'state', 'failure'].includes(key))
      .sort(compareText);
    if (resultRows.length > 0) {
      lines.push('', '## Result', '', '| Field | Value |', '| --- | --- |');
      for (const key of resultRows) lines.push(`| ${escapeCell(key)} | ${escapeCell(formatValue(report.result[key]))} |`);
    }
  }
  const caseRows = Array.isArray(report.cases) ? report.cases.filter(isRecord) : [];
  if (caseRows.length > 0) {
    lines.push('', '## Cases', '', '| Case | Seed | Status | Ticks | Coverage | Fault | Evidence |', '| --- | --- | --- | ---: | --- | --- | --- |');
    for (const item of caseRows.sort((a, b) => compareText(stringValue(a.caseId, ''), stringValue(b.caseId, '')))) {
      const fault = isRecord(item.fault) ? `${stringValue(item.fault.kind, '')}: ${stringValue(item.fault.target, '')} @ ${stringValue(item.fault.tick, '')}` : '';
      const coverage = isRecord(item.coverage) ? `${formatValue(item.coverage.visited)}${item.coverage.capacity === undefined ? '' : `/${formatValue(item.coverage.capacity)} (${formatValue(item.coverage.ratio)} ratio)`}` : '';
      lines.push(`| ${escapeCell(stringValue(item.caseId, ''))} | ${escapeCell(stringValue(item.seed, ''))} | ${escapeCell(stringValue(item.status, ''))} | ${escapeCell(stringValue(item.ticksExecuted, '0'))} | ${escapeCell(coverage)} | ${escapeCell(fault)} | ${escapeCell(stringValue(item.packagePath ?? item.packageOmittedReason, ''))} |`);
    }
  }
  const error = isRecord(report.error) ? report.error : undefined;
  if (error) lines.push('', '## Error', '', `\`${escapeCell(stringValue(error.message, 'unknown error'))}\``);
  lines.push('');
  return lines.join('\n');
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, value[key]]));
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return safe || 'case';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function nestedString(value: unknown, key: string): string {
  return isRecord(value) ? stringValue(value[key], 'unknown') : 'unknown';
}

function formatValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined || value === null) return '';
  return JSON.stringify(value) ?? '';
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
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
