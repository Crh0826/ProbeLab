import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Failure, InvalidStartRecord, ProbePackage } from '@probelab/core';
import type { ProbeViewer } from '@probelab/viewer';
import { failurePosition } from './probeLabUtils.js';
import type { StoredCase } from './types.js';

type IssueFailure = Failure | InvalidStartRecord;
export type ProbeIssue =
  | { caseId: string; failure: IssueFailure; source: 'run'; stored: StoredCase }
  | { caseId: string; failure: IssueFailure; source: 'imported'; pkg: ProbePackage };

export function buildProbeIssues(
  cases: ReadonlyArray<readonly [string, StoredCase]>,
  importedPackage: ProbePackage | undefined,
): ProbeIssue[] {
  const rows: ProbeIssue[] = [];
  for (const [caseId, stored] of cases) {
    const failure = stored.result.failure ?? stored.result.invalidStart;
    if (failure !== undefined) rows.push({ caseId, failure, source: 'run', stored });
  }
  const packageFailure = importedPackage?.outcome.failure ?? importedPackage?.outcome.invalidStart;
  if (importedPackage !== undefined && packageFailure !== undefined) {
    const issue: ProbeIssue = { caseId: importedPackage.case.caseId, failure: packageFailure, source: 'imported', pkg: importedPackage };
    const existing = rows.findIndex((row) => row.caseId === issue.caseId);
    if (existing < 0) rows.push(issue);
    else rows[existing] = issue;
  }
  return rows;
}

interface IssueNavigationOptions {
  jumpToCase: (caseId: string) => void;
  setSelected: (caseId: string | undefined) => void;
  setDisplayVersion: Dispatch<SetStateAction<'original' | 'reduced'>>;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setCurrentTick: Dispatch<SetStateAction<number>>;
  getViewer: () => ProbeViewer | undefined;
}

export function useProbeIssueNavigation(options: IssueNavigationOptions) {
  const { jumpToCase, setSelected, setDisplayVersion, setPlaying, setCurrentTick, getViewer } = options;
  return useCallback((issue: ProbeIssue): void => {
    if (issue.source === 'run') {
      jumpToCase(issue.caseId);
      return;
    }
    setSelected(issue.caseId);
    setDisplayVersion('original');
    setPlaying(false);
    setCurrentTick(Math.max(0, issue.failure.tick - 12));
    const viewer = getViewer();
    viewer?.selectTrack(issue.caseId);
    const position = failurePosition(issue.pkg.outcome);
    if (position !== undefined) viewer?.focusAt(position, 9);
  }, [jumpToCase, setSelected, setDisplayVersion, setPlaying, setCurrentTick, getViewer]);
}

export function useProbeIssues(cases: ReadonlyArray<readonly [string, StoredCase]>, activePackage: ProbePackage | undefined) {
  const importedPackageRef = useRef<ProbePackage | undefined>(undefined);
  const issueRows = useMemo(() => buildProbeIssues(cases, importedPackageRef.current === activePackage ? activePackage : undefined), [cases, activePackage]);
  const markImported = useCallback((pkg: ProbePackage): void => { importedPackageRef.current = pkg; }, []);
  return { issueRows, markImported };
}
