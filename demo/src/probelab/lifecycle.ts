import { useEffect } from 'react';
import type { ProbeViewer } from '@probelab/viewer';

type MutableRef<T> = { current: T };
interface OwnedResources {
  runnerWorkers: MutableRef<Array<{ worker: Worker }>>;
  validationWorker: MutableRef<Worker | undefined>;
  minimizeWorker: MutableRef<Worker | undefined>;
  viewer: MutableRef<ProbeViewer | undefined>;
  playbackTimer: MutableRef<number | undefined>;
}

function disposeOwnedResources(resources: OwnedResources): void {
  for (const slot of resources.runnerWorkers.current) slot.worker.terminate();
  resources.runnerWorkers.current = [];
  resources.validationWorker.current?.terminate();
  resources.validationWorker.current = undefined;
  resources.minimizeWorker.current?.terminate();
  resources.minimizeWorker.current = undefined;
  const viewer = resources.viewer.current;
  if (viewer !== undefined) viewer.dispose();
  resources.viewer.current = undefined;
  const timer = resources.playbackTimer.current;
  if (timer !== undefined) window.clearInterval(timer);
  resources.playbackTimer.current = undefined;
}

export function useProbeLabPageLifecycle(resources: OwnedResources): void {
  const { runnerWorkers, validationWorker, minimizeWorker, viewer, playbackTimer } = resources;
  useEffect(() => {
    const dispose = (): void => disposeOwnedResources({ runnerWorkers, validationWorker, minimizeWorker, viewer, playbackTimer });
    const onPageHide = (): void => dispose();
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      dispose();
    };
  }, [runnerWorkers, validationWorker, minimizeWorker, viewer, playbackTimer]);
}
