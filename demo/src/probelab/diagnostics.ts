import { useEffect } from 'react';
import { createProbeViewer, type ProbeViewer } from '@probelab/viewer';
import type { StoredCase } from './types.js';
import type { LabState, PackageValidation } from './modelTypes.js';

interface ProbeLabDiagnostics {
  getSnapshot(): {
    state: LabState;
    cases: number;
    completed: number;
    activeRunnerWorkers: number;
    validationWorkerActive: boolean;
    minimizeWorkerActive: boolean;
    failures: number;
    geometryWarnings: number;
    selectedCaseId?: string;
    currentTick: number;
    packageMode: 'view-only' | 'compatible' | 'verified' | 'incompatible' | 'unverified';
    validationState: PackageValidation['state'];
    viewer?: ReturnType<ProbeViewer['getResourceStats']>;
  };
  click(testId: string): boolean;
  getViewerStats(): ReturnType<ProbeViewer['getResourceStats']> | undefined;
  disposeCycles(iterations?: number): { iterations: number; passed: boolean; failures: string[] };
}

declare global {
  interface Window { __probeLab?: ProbeLabDiagnostics }
}

interface ProbeLabDiagnosticsOptions {
  cases: Map<string, StoredCase>;
  labState: LabState;
  activeRunnerWorkers: number;
  validationWorkerActive: boolean;
  minimizeWorkerActive: boolean;
  selectedCaseId: string | undefined;
  currentTick: number;
  validation: PackageValidation;
  geometryWarnings: string[];
  getViewer: () => ProbeViewer | undefined;
}

export function useProbeLabDiagnostics(options: ProbeLabDiagnosticsOptions): void {
  const { cases, labState, activeRunnerWorkers, validationWorkerActive, minimizeWorkerActive, selectedCaseId, currentTick, validation, geometryWarnings, getViewer } = options;
  useEffect(() => {
    const getSnapshot: ProbeLabDiagnostics['getSnapshot'] = () => {
      const values = [...cases.values()];
      const viewer = getViewer();
      return {
        state: labState,
        cases: values.length,
        completed: values.filter((entry) => entry.result.status !== 'running' && entry.result.status !== 'paused').length,
        activeRunnerWorkers,
        validationWorkerActive,
        minimizeWorkerActive,
        failures: values.filter((entry) => entry.result.failure !== undefined || entry.result.invalidStart !== undefined).length,
        geometryWarnings: geometryWarnings.length,
        ...(selectedCaseId === undefined ? {} : { selectedCaseId }),
        currentTick,
        packageMode: validation.state === 'view-only' || validation.state === 'checking' ? 'view-only' : validation.state === 'verified' ? 'verified' : validation.state === 'compatible' ? 'compatible' : validation.state === 'incompatible' ? 'incompatible' : 'unverified',
        validationState: validation.state,
        ...(viewer === undefined ? {} : { viewer: viewer.getResourceStats() }),
      };
    };
    const api: ProbeLabDiagnostics = {
      getSnapshot,
      click(testId): boolean {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${CSS.escape(testId)}"]`);
        if (button === null || button.disabled) return false;
        button.click();
        return true;
      },
      getViewerStats: () => getViewer()?.getResourceStats(),
      disposeCycles(iterations = 10): { iterations: number; passed: boolean; failures: string[] } {
        const count = Math.max(1, Math.min(50, Math.floor(iterations)));
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:240px;';
        document.body.append(host);
        const failures: string[] = [];
        const testData = {
          scene: {
            mapId: 'resource-check', coordinateSystem: 'x-right/y-up/z-forward', units: 'world units',
            bounds: { min: [-4, -1, -4] as [number, number, number], max: [4, 4, 4] as [number, number, number] },
            colliders: [{ id: 'check-box', solid: true, bounds: { min: [-1, -1, -1] as [number, number, number], max: [1, 0, 1] as [number, number, number] } }],
          },
          tracks: [{
            id: 'resource-probe',
            trace: [
              { tick: 0, position: [0, 0, 0] as [number, number, number], actorBounds: { min: [-0.3, 0, -0.3] as [number, number, number], max: [0.3, 1.8, 0.3] as [number, number, number] } },
              { tick: 1, position: [1, 0, 0] as [number, number, number], actorBounds: { min: [0.7, 0, -0.3] as [number, number, number], max: [1.3, 1.8, 0.3] as [number, number, number] } },
            ],
          }],
        };
        try {
          for (let index = 0; index < count; index += 1) {
            const instance = createProbeViewer(host);
            instance.setData(testData);
            const stats = instance.dispose();
            if (stats.activeAnimationFrames !== 0 || stats.activeListeners !== 0 || stats.activeResizeObservers !== 0 || stats.tracks !== 0) failures.push(`cycle ${index + 1}: active resource counts remain`);
            if (stats.geometriesCreated !== stats.geometriesDisposed) failures.push(`cycle ${index + 1}: geometry ${stats.geometriesCreated}/${stats.geometriesDisposed}`);
            if (stats.materialsCreated !== stats.materialsDisposed) failures.push(`cycle ${index + 1}: material ${stats.materialsCreated}/${stats.materialsDisposed}`);
          }
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : String(cause));
        } finally {
          host.remove();
        }
        return { iterations: count, passed: failures.length === 0, failures };
      },
    };
    window.__probeLab = api;
    return () => { if (window.__probeLab === api) delete window.__probeLab; };
  }, [cases, labState, activeRunnerWorkers, validationWorkerActive, minimizeWorkerActive, selectedCaseId, currentTick, validation, geometryWarnings, getViewer]);
}
