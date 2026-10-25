import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { importProbePackage } from '@probelab/core';
import { createProbeViewer, type ProbeViewer } from '@probelab/viewer';
import { getTarget } from './targets.js';
import type {
  ProbeScenarioId,
  RunnerWorkerCommand,
  RunnerWorkerMessage,
  RunSettings,
  CaseViewResult,
  MinimizeCancelRequest,
  StoredCase,
  ValidationWorkerRequest,
  ValidationWorkerResponse,
} from './types.js';
import { MAX_PROBE_TICKS } from './types.js';
import { useProbeIssueNavigation, useProbeIssues } from './issues.js';
import type { DebugWorld, ProbePackage } from '@probelab/core';
import type { LabState, PackageValidation } from './modelTypes.js';
import { EMPTY_WORLD, coverageOf, failurePosition, readGeometryWarnings, seedFor, toTrack } from './probeLabUtils.js';
import { useProbeLabDiagnostics } from './diagnostics.js';
import { useProbeLabPageLifecycle } from './lifecycle.js';

interface WorkerSlot { worker: Worker; caseIndex: number }

export function useProbeLabModel() {
  const viewerHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ProbeViewer | undefined>(undefined);
  const getViewer = useCallback(() => viewerRef.current, []);
  const workersRef = useRef<WorkerSlot[]>([]);
  const nextCaseIndexRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const pausedRef = useRef(false);
  const caseCountRef = useRef(16);
  const runningWorkersRef = useRef(0);
  const minimizeWorkerRef = useRef<Worker | undefined>(undefined);
  const validationWorkerRef = useRef<Worker | undefined>(undefined);
  const playbackTimerRef = useRef<number | undefined>(undefined);
  const onPickTrackRef = useRef<(caseId: string) => void>(() => undefined);
  const [labState, setLabState] = useState<LabState>('idle');
  const [targetId, setTargetId] = useState('sandbox');
  const [mapId, setMapId] = useState('foundry');
  const [scenario, setScenario] = useState<ProbeScenarioId>('healthy');
  const [rootSeed, setRootSeed] = useState('ProbeLab-2026');
  const [probeCount, setProbeCount] = useState(16);
  const [simulationConcurrency, setSimulationConcurrency] = useState(4);
  const [visibleProbeCount, setVisibleProbeCount] = useState(16);
  const [maxTicks, setMaxTicks] = useState(MAX_PROBE_TICKS);
  const [cases, setCases] = useState<Map<string, StoredCase>>(() => new Map());
  const [debugWorld, setDebugWorld] = useState<DebugWorld>();
  const [selectedCaseId, setSelectedCaseId] = useState<string>();
  const [activePackage, setActivePackage] = useState<ProbePackage>();
  const [reducedPackage, setReducedPackage] = useState<ProbePackage>();
  const [displayVersion, setDisplayVersion] = useState<'original' | 'reduced'>('original');
  const [validation, setValidation] = useState<PackageValidation>({ state: 'view-only', message: '尚未验证 · 仅查看记录', differences: [] });
  const [message, setMessage] = useState('');
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [currentTick, setCurrentTick] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [showColliders, setShowColliders] = useState(true);
  const [showPaths, setShowPaths] = useState(true);
  const [showActors, setShowActors] = useState(true);
  const [showActorAabbs, setShowActorAabbs] = useState(true);
  const [isMinimizing, setIsMinimizing] = useState(false);
  const [isCancellingMinimize, setIsCancellingMinimize] = useState(false);
  const [reducedFullyVerified, setReducedFullyVerified] = useState(false);
  const [minimizeLabel, setMinimizeLabel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedTarget = getTarget(targetId);
  const configurationLocked = labState === 'running' || labState === 'paused' || labState === 'stopping' || isMinimizing;
  const isSandbox = targetId !== 'fps';
  const packageToShow = displayVersion === 'reduced' && reducedPackage !== undefined ? reducedPackage : activePackage;
  const sortedCases = useMemo(() => [...cases.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })), [cases]);
  const { issueRows, markImported } = useProbeIssues(sortedCases, activePackage);
  const completedCount = useMemo(() => sortedCases.filter(([, stored]) => stored.result.status !== 'running' && stored.result.status !== 'paused').length, [sortedCases]);
  const totalTicks = useMemo(() => sortedCases.reduce((sum, [, stored]) => sum + stored.result.ticksExecuted, 0), [sortedCases]);
  const plannedTicks = probeCount * maxTicks;
  const coverage = useMemo(() => coverageOf(cases, debugWorld), [cases, debugWorld]);
  const geometryWarnings = useMemo(() => readGeometryWarnings(debugWorld), [debugWorld]);
  const demoLabel = useMemo(() => {
    if (targetId === 'sandbox-fixed' || packageToShow?.descriptor.adapterId.includes('fixed') === true) return undefined;
    const metadata = debugWorld?.metadata;
    if (metadata === null || metadata === undefined || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    const value = (metadata as Record<string, unknown>)['demoInjection'];
    return typeof value === 'string' && value !== 'none' ? value : undefined;
  }, [debugWorld, targetId, packageToShow]);
  const effectiveSelectedCaseId = selectedCaseId ?? sortedCases[0]?.[0];
  const selectedStored = effectiveSelectedCaseId === undefined ? undefined : cases.get(effectiveSelectedCaseId);
  const selectedFailure = selectedStored?.result.failure ?? selectedStored?.result.invalidStart;
  const selectedTrace = packageToShow?.outcome.trace ?? selectedStored?.result.trace ?? [];
  const selectedFrame = selectedTrace.find((frame) => frame.tick === currentTick) ?? selectedTrace.filter((frame) => frame.tick <= currentTick).at(-1);
  const selectedTraceMax = selectedTrace.at(-1)?.tick ?? 0;
  const canMinimize = packageToShow?.outcome.failure !== undefined && (validation.state === 'verified' || validation.state === 'compatible') && labState !== 'running';

  const setSelected = useCallback((caseId: string | undefined): void => {
    setSelectedCaseId(caseId);
  }, []);

  const jumpToCase = useCallback((caseId: string): void => {
    const stored = cases.get(caseId);
    if (stored === undefined) return;
    setSelected(caseId);
    const failure = stored.result.failure ?? stored.result.invalidStart;
    const newTick = failure === undefined ? 0 : Math.max(0, failure.tick - 12);
    setCurrentTick(newTick);
    setPlaying(false);
    viewerRef.current?.selectTrack(caseId);
    const position = failurePosition(stored.result);
    if (position !== undefined) viewerRef.current?.focusAt(position, 9);
    if (stored.pkg !== undefined) {
      setActivePackage(stored.pkg);
      setReducedPackage(undefined);
      setReducedFullyVerified(false);
      setDisplayVersion('original');
      setValidation({ state: 'compatible', message: '由本次 adapter 生成 · 严格重放尚未执行', differences: [] });
    }
  }, [cases, setSelected]);

  onPickTrackRef.current = jumpToCase;

  useEffect(() => {
    const host = viewerHostRef.current;
    if (host === null) return;
    try {
      const viewer = createProbeViewer(host, {
        onPickTrack: (caseId) => onPickTrackRef.current(caseId),
        onRenderError: (error) => setMessage(`Three.js 查看器错误：${error.message}`),
      });
      viewerRef.current = viewer;
    } catch (cause) {
      setMessage(`无法创建 WebGL 查看器：${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    if (packageToShow !== undefined) {
      viewer.loadPackage(packageToShow);
    } else {
      const entries = sortedCases.filter(([, stored]) => stored.result.trace.length > 0).slice(0, visibleProbeCount);
      viewer.setData({
        scene: debugWorld ?? EMPTY_WORLD,
        tracks: entries.map(([id, stored]) => toTrack(id, stored)),
      });
    }
    viewer.selectTrack(effectiveSelectedCaseId);
    viewer.setTick(currentTick);
  }, [packageToShow, sortedCases, debugWorld, visibleProbeCount, effectiveSelectedCaseId, currentTick]);

  useEffect(() => {
    viewerRef.current?.setVisibility({ grid: showGrid, colliders: showColliders, paths: showPaths, actors: showActors, aabbs: showActorAabbs });
  }, [showGrid, showColliders, showPaths, showActors, showActorAabbs]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setCurrentTick((tick) => {
        if (selectedTraceMax <= 0) return 0;
        const next = tick + Math.max(1, Math.round(12 * speed));
        if (next >= selectedTraceMax) {
          setPlaying(false);
          return selectedTraceMax;
        }
        return next;
      });
    }, 100);
    playbackTimerRef.current = timer;
    return () => {
      window.clearInterval(timer);
      if (playbackTimerRef.current === timer) playbackTimerRef.current = undefined;
    };
  }, [playing, selectedTraceMax, speed]);

  useProbeLabDiagnostics({
    cases,
    labState,
    activeRunnerWorkers: workersRef.current.length,
    validationWorkerActive: validationWorkerRef.current !== undefined,
    minimizeWorkerActive: minimizeWorkerRef.current !== undefined,
    selectedCaseId,
    currentTick,
    validation,
    geometryWarnings,
    getViewer,
  });

  useProbeLabPageLifecycle({
    runnerWorkers: workersRef,
    validationWorker: validationWorkerRef,
    minimizeWorker: minimizeWorkerRef,
    viewer: viewerRef,
    playbackTimer: playbackTimerRef,
  });

  const assignCase = useCallback((slot: WorkerSlot, caseIndex: number, settings: RunSettings): void => {
    const caseId = `${settings.targetId === 'fps' ? settings.map : settings.targetId}-${String(caseIndex + 1).padStart(2, '0')}`;
    slot.caseIndex = caseIndex;
    const command: RunnerWorkerCommand = {
      type: 'run',
      targetId: settings.targetId,
      map: settings.map,
      scenario: settings.scenario,
      caseIndex,
      caseId,
      seed: seedFor(settings.rootSeed, settings.targetId, settings.map, caseIndex),
      maxTicks: settings.maxTicks,
      initialPaused: pausedRef.current,
    };
    slot.worker.postMessage(command);
  }, []);

  const startRun = useCallback((): void => {
    if (selectedTarget === undefined || configurationLocked) return;
    if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > MAX_PROBE_TICKS) {
      setMessage(`每探针预算必须是 1–${MAX_PROBE_TICKS} 个整数 tick`);
      return;
    }
    for (const slot of workersRef.current) slot.worker.terminate();
    workersRef.current = [];
    minimizeWorkerRef.current?.terminate();
    minimizeWorkerRef.current = undefined;
    validationWorkerRef.current?.terminate();
    validationWorkerRef.current = undefined;
    const settings: RunSettings = {
      targetId,
      map: mapId,
      scenario: isSandbox ? scenario : 'healthy',
      rootSeed,
      probeCount,
      simulationConcurrency: Math.min(probeCount, Math.max(1, simulationConcurrency)),
      visibleProbeCount: Math.min(probeCount, Math.max(1, visibleProbeCount)),
      maxTicks,
    };
    caseCountRef.current = settings.probeCount;
    nextCaseIndexRef.current = Math.min(settings.probeCount, settings.simulationConcurrency);
    runningWorkersRef.current = Math.min(settings.probeCount, settings.simulationConcurrency);
    stopRequestedRef.current = false;
    pausedRef.current = false;
    setCases(new Map());
    setDebugWorld(undefined);
    setActivePackage(undefined);
    setReducedPackage(undefined);
    setReducedFullyVerified(false);
    setValidation({ state: 'view-only', message: '正在运行 · 每条记录均来自真实模拟', differences: [] });
    setDisplayVersion('original');
    setSelected(undefined);
    setCurrentTick(0);
    setPlaying(false);
    setMessage('');
    setLabState('running');
    try {
      const pool = Array.from({ length: settings.simulationConcurrency }, (_, index) => {
        const worker = new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module' });
        const slot: WorkerSlot = { worker, caseIndex: index };
        workersRef.current.push(slot);
        worker.onmessage = (event: MessageEvent<RunnerWorkerMessage>): void => {
          const data = event.data;
          if (data.type === 'progress') {
            setSelectedCaseId((current) => current ?? data.caseId);
            if (data.debugWorld !== undefined) setDebugWorld(data.debugWorld);
            setCases((previous) => {
              const next = new Map(previous);
              const prior = next.get(data.caseId);
              const base: CaseViewResult = prior?.result ?? { caseId: data.caseId, seed: data.result.seed, status: 'running', ticksExecuted: 0, trace: [] };
              next.set(data.caseId, {
                ...prior,
                result: {
                  ...base,
                  ...data.result,
                  trace: [...base.trace, ...data.traceDelta],
                },
                ...(data.debugWorld === undefined ? {} : { debugWorld: data.debugWorld }),
              });
              return next;
            });
            return;
          }
          if (data.type === 'error') {
            setMessage(`探针 ${data.caseId ?? ''} 执行错误：${data.message}`);
            const caseId = data.caseId ?? `${settings.targetId === 'fps' ? settings.map : settings.targetId}-${String(slot.caseIndex + 1).padStart(2, '0')}`;
            setCases((previous) => {
              const next = new Map(previous);
              next.set(caseId, { result: { caseId, seed: seedFor(settings.rootSeed, settings.targetId, settings.map, slot.caseIndex), status: 'failed', ticksExecuted: 0, trace: [], error: { name: 'ProbeWorkerError', message: data.message, tick: 0 } } });
              return next;
            });
            if (!stopRequestedRef.current && nextCaseIndexRef.current < caseCountRef.current) {
              const nextIndex = nextCaseIndexRef.current;
              nextCaseIndexRef.current += 1;
              assignCase(slot, nextIndex, settings);
            } else {
              slot.worker.terminate();
              workersRef.current = workersRef.current.filter((entry) => entry.worker !== slot.worker);
              runningWorkersRef.current = Math.max(0, runningWorkersRef.current - 1);
              if (runningWorkersRef.current === 0) setLabState(stopRequestedRef.current ? 'stopped' : 'error');
            }
            return;
          }
          setCases((previous) => {
            const next = new Map(previous);
            next.set(data.caseId, { result: data.result, ...(data.debugWorld === undefined ? {} : { debugWorld: data.debugWorld }), ...(data.package === undefined ? {} : { pkg: data.package }) });
            return next;
          });
          if (data.debugWorld !== undefined) setDebugWorld(data.debugWorld);
          if (data.error !== undefined) setMessage(`探针 ${data.caseId}：${data.error}`);
          if (!stopRequestedRef.current && nextCaseIndexRef.current < caseCountRef.current) {
            const nextIndex = nextCaseIndexRef.current;
            nextCaseIndexRef.current += 1;
            assignCase(slot, nextIndex, settings);
          } else {
            slot.worker.terminate();
            workersRef.current = workersRef.current.filter((entry) => entry.worker !== slot.worker);
            runningWorkersRef.current = Math.max(0, runningWorkersRef.current - 1);
            if (runningWorkersRef.current === 0) {
              setLabState(stopRequestedRef.current ? 'stopped' : 'complete');
              setMessage(stopRequestedRef.current ? '已停止 · 已保留所有已完成和部分探针记录' : '探索完成 · 所有显示数字来自本次运行');
            }
          }
        };
        worker.onerror = (event: ErrorEvent): void => {
          setMessage(`探针 Worker 错误：${event.message}`);
          worker.terminate();
          workersRef.current = workersRef.current.filter((entry) => entry.worker !== worker);
          runningWorkersRef.current = Math.max(0, runningWorkersRef.current - 1);
          if (runningWorkersRef.current === 0) setLabState('error');
        };
        return slot;
      });
      pool.forEach((slot, index) => assignCase(slot, index, settings));
    } catch (cause) {
      for (const slot of workersRef.current) slot.worker.terminate();
      workersRef.current = [];
      runningWorkersRef.current = 0;
      setLabState('error');
      setMessage(`无法启动探针 Worker：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [selectedTarget, configurationLocked, targetId, mapId, isSandbox, scenario, rootSeed, probeCount, simulationConcurrency, visibleProbeCount, maxTicks, assignCase, setSelected]);

  const pauseRun = (): void => {
    pausedRef.current = true;
    for (const slot of workersRef.current) slot.worker.postMessage({ type: 'pause' } satisfies RunnerWorkerCommand);
    setLabState('paused');
  };
  const resumeRun = (): void => {
    pausedRef.current = false;
    for (const slot of workersRef.current) slot.worker.postMessage({ type: 'resume' } satisfies RunnerWorkerCommand);
    setLabState('running');
  };
  const stopRun = (): void => {
    stopRequestedRef.current = true;
    pausedRef.current = false;
    setLabState('stopping');
    for (const slot of workersRef.current) slot.worker.postMessage({ type: 'stop' } satisfies RunnerWorkerCommand);
    if (workersRef.current.length === 0) setLabState('stopped');
  };

  const chooseIssue = useProbeIssueNavigation({ jumpToCase, setSelected, setDisplayVersion, setPlaying, setCurrentTick, getViewer });
  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file === undefined) return;
    try {
      const imported = importProbePackage(await file.text());
      if (!imported.ok) throw new Error(`${imported.code}: ${imported.message}`);
      markImported(imported.value);
      setActivePackage(imported.value);
      setReducedPackage(undefined);
      setReducedFullyVerified(false);
      setDisplayVersion('original');
      setDebugWorld(imported.value.encoded.debugWorld);
      setCurrentTick(0);
      setSelected(imported.value.case.caseId);
      setValidation({ state: 'view-only', message: '已导入 · 仅查看记录，尚未执行兼容验证', differences: [] });
      setLabState((state) => state === 'running' ? state : 'idle');
      setMessage(`已导入 ${file.name} · 数据通过结构与完整性检查`);
    } catch (cause) {
      setMessage(`导入失败：${cause instanceof Error ? cause.message : String(cause)}。当前现场保持不变。`);
    }
  };

  const exportPackage = (): void => {
    const pkg = packageToShow ?? (selectedCaseId === undefined ? undefined : cases.get(selectedCaseId)?.pkg);
    if (pkg === undefined) {
      setMessage('尚无可导出的故障包。请先选择已完成的故障探针。');
      return;
    }
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${pkg.case.caseId}.probe.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage('故障包已导出为可移交的数据文件。');
  };

  const runValidation = (): void => {
    if (packageToShow === undefined) return;
    const target = selectedTarget;
    if (target === undefined) {
      setValidation({ state: 'incompatible', message: '没有可用的兼容模拟器 · 仅查看记录', differences: ['未选择可用 adapter'] });
      return;
    }
    validationWorkerRef.current?.terminate();
    validationWorkerRef.current = undefined;
    setValidation({ state: 'checking', message: '正在检查兼容性并执行严格重放…', differences: [] });
    const worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
    validationWorkerRef.current = worker;
    const request: ValidationWorkerRequest = { type: 'validate', targetId: target.id, pkg: packageToShow, map: mapId, scenario };
    worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>): void => {
      const result = event.data;
      worker.terminate();
      if (validationWorkerRef.current === worker) validationWorkerRef.current = undefined;
      if (result.type === 'validation-error') {
        setValidation({ state: 'error', message: `验证错误：${result.message}`, differences: [] });
        return;
      }
      if (result.type !== 'validated') return;
      if (!result.compatibility.compatible) {
        setValidation({ state: 'incompatible', message: 'Adapter 或记录版本不兼容 · 保持仅查看状态', differences: result.compatibility.differences });
        return;
      }
      const replay = result.replay;
      if (replay === undefined) {
        setValidation({ state: 'compatible', message: '版本兼容 · 尚无重放结果', differences: [] });
      } else if (replay.status === 'verified-failure') {
        setValidation({ state: 'verified', message: '严格重放通过 · 首故障签名一致', differences: [], ...(replay.firstDivergentTick === undefined ? {} : { firstDivergentTick: replay.firstDivergentTick }) });
      } else if (replay.status === 'diverged') {
        setValidation({ state: 'diverged', message: `重放发生分歧${replay.reason === undefined ? '' : `：${replay.reason}`}`, differences: [], ...(replay.firstDivergentTick === undefined ? {} : { firstDivergentTick: replay.firstDivergentTick }) });
      } else if (replay.status === 'healthy') {
        setValidation({ state: 'healthy', message: '重放完成 · 本次结果健康', differences: [] });
      } else {
        setValidation({ state: 'error', message: `重放未完成：${replay.reason ?? replay.status}`, differences: [] });
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      if (validationWorkerRef.current === worker) validationWorkerRef.current = undefined;
      setValidation({ state: 'error', message: `验证 Worker 错误：${event.message}`, differences: [] });
    };
    worker.postMessage(request);
  };

  const minimize = (): void => {
    if (isMinimizing) {
      if (!isCancellingMinimize) {
        minimizeWorkerRef.current?.postMessage({ type: 'cancel-minimize' } satisfies MinimizeCancelRequest);
        setIsCancellingMinimize(true);
        setMinimizeLabel('正在取消 · 等待当前最佳已验证候选返回…');
      }
      return;
    }
    if (packageToShow === undefined) return;
    const worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
    minimizeWorkerRef.current = worker;
    setIsMinimizing(true);
    setIsCancellingMinimize(false);
    setMinimizeLabel('正在真实重放候选序列…');
    const request: ValidationWorkerRequest = { type: 'minimize', targetId: selectedTarget?.id ?? 'fps', pkg: packageToShow, map: mapId, scenario };
    worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>): void => {
      worker.terminate();
      minimizeWorkerRef.current = undefined;
      setIsMinimizing(false);
      setIsCancellingMinimize(false);
      const response = event.data;
      if (response.type === 'validation-error') {
        setMinimizeLabel(`缩减失败：${response.message}`);
      } else if (response.type === 'minimized') {
        const result = response.result;
        const shorter = result.reducedLength < result.originalLength;
        const fullyVerified = shorter && result.replayVerifications >= 2;
        const statusLabel = result.status === 'reduced' ? '缩减完成' : result.status === 'cancelled' ? '已取消' : result.status === 'budget-exhausted' ? '预算耗尽' : result.status === 'not-reproducible' ? '无法重现' : '未能继续缩短';
        setMinimizeLabel(`${statusLabel} · ${result.originalLength} → ${result.reducedLength} ticks · ${result.attempts} 次候选 · ${result.replayVerifications} 次复验`);
        if (result.package !== undefined && shorter) {
          setReducedPackage(result.package);
          setDisplayVersion('reduced');
          setReducedFullyVerified(fullyVerified);
          const verificationMessage = fullyVerified ? result.status === 'budget-exhausted' ? '预算耗尽 · 当前更短序列已完成两次独立重放验证' : '缩减序列完成两次独立重放验证' : `展示当前best候选 · ${result.replayVerifications} 次复验`;
          setValidation({ state: fullyVerified ? 'verified' : 'compatible', message: verificationMessage, differences: [] });
          setCurrentTick(0);
        }
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      minimizeWorkerRef.current = undefined;
      setIsMinimizing(false);
      setIsCancellingMinimize(false);
      setMinimizeLabel(`缩减 Worker 错误：${event.message}`);
    };
    worker.postMessage(request);
  };

  const moveTick = (amount: number): void => {
    setPlaying(false);
    setCurrentTick((tick) => Math.max(0, Math.min(selectedTraceMax, tick + amount)));
  };
  const jumpFailure = (): void => {
    const failure = packageToShow?.outcome.failure ?? packageToShow?.outcome.invalidStart ?? selectedFailure;
    if (failure === undefined) return;
    setPlaying(false);
    setCurrentTick(Math.max(0, failure.tick - 12));
    const frame = selectedTrace.find((entry) => entry.tick === failure.tick && entry.position !== undefined) ?? selectedTrace.filter((entry) => entry.tick < failure.tick && entry.position !== undefined).at(-1);
    if (frame?.position !== undefined) viewerRef.current?.focusAt(frame.position, 8);
  };

  const caseProgress = probeCount > 0 ? Math.min(100, (completedCount / probeCount) * 100) : 0;
  const hasPackage = packageToShow !== undefined;
  const displayedFailure = packageToShow?.outcome.failure ?? packageToShow?.outcome.invalidStart ?? selectedFailure;
  const rawState = selectedFrame?.state ?? packageToShow?.outcome.failure?.state ?? selectedStored?.result.failure?.state;
  const currentCommand = selectedFrame?.command;
  const canUsePackage = packageToShow !== undefined;

  return {
    viewerHostRef,
    labState,
    targetId,
    setTargetId,
    scenario,
    setScenario,
    configurationLocked,
    mapId,
    setMapId,
    rootSeed,
    setRootSeed,
    probeCount,
    setProbeCount,
    visibleProbeCount,
    setVisibleProbeCount,
    simulationConcurrency,
    setSimulationConcurrency,
    maxTicks,
    setMaxTicks,
    startRun,
    pauseRun,
    resumeRun,
    stopRun,
    caseProgress,
    completedCount,
    totalTicks,
    plannedTicks,
    coverage,
    issueRows,
    sortedCases,
    debugWorld,
    geometryWarnings,
    demoLabel,
    showGrid,
    setShowGrid,
    showColliders,
    setShowColliders,
    showActorAabbs,
    setShowActorAabbs,
    showPaths,
    setShowPaths,
    showActors,
    setShowActors,
    packageToShow,
    selectedCaseId,
    jumpToCase,
    chooseIssue,
    selectedFrame,
    displayedFailure,
    validation,
    isMinimizing,
    isCancellingMinimize,
    canMinimize,
    canUsePackage,
    runValidation,
    minimize,
    minimizeLabel,
    fileInputRef,
    importFile,
    exportPackage,
    hasPackage,
    displayVersion,
    setDisplayVersion,
    activePackage,
    reducedPackage,
    reducedFullyVerified,
    selectedStored,
    currentCommand,
    rawState,
    jumpFailure,
    moveTick,
    playing,
    setPlaying,
    currentTick,
    setCurrentTick,
    selectedTraceMax,
    speed,
    setSpeed,
    message,
    setMessage,
  };
}
