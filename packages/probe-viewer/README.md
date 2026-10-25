# @probelab/viewer

Standalone browser viewer for `@probelab/core` trace packages. It only depends on the core protocol types/runtime and the consumer's Three.js peer dependency; it does not import FPS or React modules.

```ts
import { createProbeViewer } from '@probelab/viewer';
import '@probelab/viewer/style.css';
import type { ProbePackage } from '@probelab/core';

const host = document.querySelector<HTMLElement>('#viewer');
if (!host) throw new Error('viewer host missing');

const viewer = createProbeViewer(host, {
  showGrid: true,
  showColliders: true,
  showAabbs: true,
});
viewer.loadPackage(JSON.parse(await file.text()) as ProbePackage);
viewer.setTick(24);
viewer.focusAt([0, 0, 0]);

// On route exit or host teardown:
const resources = viewer.dispose();
console.info(resources.activeAnimationFrames, resources.activeListeners);
```

`loadPackage` uses `encoded.debugWorld` and the recorded trace; it never loads or evaluates modules named by package data. This provides **view-only** playback. Verification requires the host to call the core replay APIs with an explicitly selected compatible adapter.

`setData` also accepts multiple independent `ProbeViewerTrack`s, which lets the host draw the concurrent exploration traces. Actor bounds are shown only when actual per-tick AABBs exist in the trace. Drag to orbit, scroll to zoom, and use `focusAt` to center a selected failure.

The returned object owns its renderer, render loop, resize observer, listeners, geometries, and materials. `getResourceStats()` reports active owned resources; after `dispose()` the active counts must be zero. `dispose()` is idempotent.

The package is marked `MIT`; it is not published. Run `npm run build -w @probelab/viewer` to emit `dist/index.js`, declarations, and `dist/style.css`.
