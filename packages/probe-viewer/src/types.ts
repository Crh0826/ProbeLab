import type { DebugWorld, FailureKind, ProbePackage, TickSummary } from '@probelab/core';

export interface ProbeViewerFrame {
  tick: number;
  position?: [number, number, number];
  yaw?: number;
  actorBounds?: { min: [number, number, number]; max: [number, number, number] };
  command?: unknown;
  state?: unknown;
}

export interface ProbeViewerFailure {
  kind: FailureKind;
  tick: number;
  target: string;
  position?: [number, number, number];
}

export interface ProbeViewerTrack {
  id: string;
  label?: string;
  color?: string;
  trace: readonly ProbeViewerFrame[];
  failure?: ProbeViewerFailure;
}

export interface ProbeViewerData {
  scene: DebugWorld;
  tracks: readonly ProbeViewerTrack[];
}

export interface ProbeViewerOptions {
  data?: ProbeViewerData;
  background?: string;
  pixelRatio?: number;
  showGrid?: boolean;
  showColliders?: boolean;
  showPaths?: boolean;
  showActors?: boolean;
  showAabbs?: boolean;
  onPickTrack?: (trackId: string) => void;
  onRenderError?: (error: Error) => void;
}

export interface ProbeViewerVisibility {
  grid?: boolean;
  colliders?: boolean;
  paths?: boolean;
  actors?: boolean;
  aabbs?: boolean;
}

export interface ProbeViewerResourceStats {
  disposed: boolean;
  activeAnimationFrames: number;
  activeListeners: number;
  activeResizeObservers: number;
  geometriesCreated: number;
  geometriesDisposed: number;
  materialsCreated: number;
  materialsDisposed: number;
  tracks: number;
}

export interface ProbeViewer {
  setData(data: ProbeViewerData): void;
  loadPackage(pkg: ProbePackage): void;
  setTick(tick: number): void;
  getTick(): number;
  focusAt(position: [number, number, number], radius?: number): void;
  selectTrack(trackId: string | undefined): void;
  setVisibility(visibility: ProbeViewerVisibility): void;
  getResourceStats(): ProbeViewerResourceStats;
  dispose(): ProbeViewerResourceStats;
}

export type { DebugWorld, ProbePackage, TickSummary };
