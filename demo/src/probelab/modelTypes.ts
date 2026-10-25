export type LabState = 'idle' | 'running' | 'paused' | 'stopping' | 'complete' | 'stopped' | 'error';

export type PackageValidation = {
  state: 'view-only' | 'checking' | 'compatible' | 'incompatible' | 'verified' | 'diverged' | 'healthy' | 'error';
  message: string;
  differences: string[];
  firstDivergentTick?: number;
};
