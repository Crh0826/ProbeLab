import * as THREE from 'three';
import type { ProbePackage } from '@probelab/core';
import type {
  ProbeViewer,
  ProbeViewerData,
  ProbeViewerOptions,
  ProbeViewerResourceStats,
  ProbeViewerTrack,
  ProbeViewerVisibility,
} from './types.js';

interface TrackObjects {
  track: ProbeViewerTrack;
  group: THREE.Group;
  actor: THREE.Mesh;
  nose: THREE.Mesh;
  hitbox: THREE.Mesh;
  failure: THREE.Mesh | undefined;
}

const palette = ['#69d4bd', '#70a9ff', '#f0b35c', '#d89aff', '#ff7e73', '#95d66f', '#72d5e8', '#ff9ec0', '#c3ce6f', '#b2a0ff', '#fa8b53', '#65c6a1', '#8ca9d9', '#d5a86b', '#de87d5', '#c1d4e2'];
const failureColors: Record<string, string> = {
  'out-of-bounds': '#ff914f',
  penetration: '#ff526a',
  'non-finite-state': '#d182ff',
  'invalid-start': '#ffcf5a',
};

function vector(value: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
}

function disposeMaterial(material: THREE.Material, counters: { materialsDisposed: number }): void {
  material.dispose();
  counters.materialsDisposed += 1;
}

function clearGroup(group: THREE.Group, counters: { geometriesDisposed: number; materialsDisposed: number }): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    if (child === undefined) continue;
    group.remove(child);
    child.traverse((object) => {
      const disposable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (disposable.geometry !== undefined) {
        disposable.geometry.dispose();
        counters.geometriesDisposed += 1;
      }
      if (disposable.material !== undefined) {
        const materials = Array.isArray(disposable.material) ? disposable.material : [disposable.material];
        for (const material of materials) disposeMaterial(material, counters);
      }
    });
  }
}

function failureGeometry(kind: string): THREE.BufferGeometry {
  if (kind === 'out-of-bounds') return new THREE.ConeGeometry(0.25, 0.55, 4);
  if (kind === 'non-finite-state') return new THREE.OctahedronGeometry(0.32, 0);
  if (kind === 'invalid-start') return new THREE.TetrahedronGeometry(0.35, 0);
  return new THREE.IcosahedronGeometry(0.32, 0);
}

function framePosition(frame: ProbeViewerTrack['trace'][number]): [number, number, number] | undefined {
  if (frame.position !== undefined && frame.position.every(Number.isFinite)) return frame.position;
  return undefined;
}

function packageTrack(pkg: ProbePackage): ProbeViewerTrack {
  const failure = pkg.outcome.failure ?? pkg.outcome.invalidStart;
  const failureFrame = failure === undefined ? undefined : pkg.outcome.trace.find((frame) => frame.tick === failure.tick) ?? pkg.outcome.trace.filter((frame) => frame.tick < failure.tick && frame.position !== undefined).at(-1);
  const failureKind = failure?.kind ?? 'invalid-start';
  return {
    id: pkg.case.caseId,
    label: `${pkg.case.caseId} · ${failureKind}`,
    color: failureColors[failureKind] ?? palette[0],
    trace: pkg.outcome.trace.map((frame) => ({
      tick: frame.tick,
      position: frame.position,
      actorBounds: frame.actorBounds,
      state: frame.state,
      command: frame.command,
    })),
    ...(failure === undefined ? {} : {
      failure: {
        kind: failureKind,
        tick: failure.tick,
        target: failure.signature.target,
        position: failureFrame?.position,
      },
    }),
  };
}

/** Creates a self-contained Three.js scene viewer. All GPU objects/listeners are owned and disposed by the returned instance. */
export function createProbeViewer(root: HTMLElement, options: ProbeViewerOptions = {}): ProbeViewer {
  const stage = document.createElement('div');
  stage.className = 'probe-viewer-stage';
  stage.style.position = 'relative';
  stage.style.width = '100%';
  stage.style.height = '100%';
  stage.style.minHeight = '240px';
  stage.style.overflow = 'hidden';
  stage.style.touchAction = 'none';
  stage.style.background = options.background ?? '#10161d';
  stage.tabIndex = 0;
  stage.setAttribute('role', 'application');
  stage.setAttribute('aria-label', 'ProbeLab 3D trace viewer. Drag to orbit, scroll to zoom.');
  root.append(stage);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? '#10161d');
  scene.fog = new THREE.Fog(options.background ?? '#10161d', 80, 260);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  } catch (cause) {
    stage.remove();
    throw cause;
  }
  renderer.setPixelRatio(Math.min(options.pixelRatio ?? window.devicePixelRatio ?? 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  stage.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xcbe8ef, 0x25303b, 2.0));
  const keyLight = new THREE.DirectionalLight(0xffe0b4, 2.4);
  keyLight.position.set(-12, 22, 14);
  scene.add(keyLight);

  const worldGroup = new THREE.Group();
  const pathGroup = new THREE.Group();
  const actorGroup = new THREE.Group();
  scene.add(worldGroup, pathGroup, actorGroup);

  const resizeCounters = { activeResizeObservers: 0 };
  const counters = { geometriesCreated: 0, geometriesDisposed: 0, materialsCreated: 0, materialsDisposed: 0 };
  const listeners: Array<{ target: EventTarget; type: string; listener: EventListener; options?: AddEventListenerOptions | boolean }> = [];
  const listen = (target: EventTarget, type: string, listener: EventListener, eventOptions?: AddEventListenerOptions | boolean): void => {
    target.addEventListener(type, listener, eventOptions);
    listeners.push({ target, type, listener, options: eventOptions });
  };

  let data: ProbeViewerData | undefined;
  let trackObjects: TrackObjects[] = [];
  let currentTick = 0;
  let selectedTrack: string | undefined;
  let visible: Required<ProbeViewerVisibility> = {
    grid: options.showGrid ?? true,
    colliders: options.showColliders ?? true,
    paths: options.showPaths ?? true,
    actors: options.showActors ?? true,
    aabbs: options.showAabbs ?? true,
  };
  let disposed = false;
  let frameId = 0;
  let errorReported = false;
  let activeDrag: { id: number; x: number; y: number; moved: boolean } | undefined;
  let theta = Math.PI * 0.25;
  let phi = Math.PI * 0.32;
  let radius = 28;
  const target = new THREE.Vector3(0, 0, 0);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const buildGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    counters.geometriesCreated += 1;
    return geometry;
  };
  const buildMaterial = <T extends THREE.Material>(material: T): T => {
    counters.materialsCreated += 1;
    return material;
  };
  const resize = (): void => {
    if (disposed) return;
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const setCameraPosition = (): void => {
    const sinPhi = Math.sin(phi);
    camera.position.set(
      target.x + radius * sinPhi * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sinPhi * Math.cos(theta),
    );
    camera.lookAt(target);
  };

  const buildWorld = (world: ProbeViewerData['scene']): void => {
    clearGroup(worldGroup, counters);
    let gridSize = 80;
    let center = new THREE.Vector3();
    let floorY = 0;
    if (world.bounds !== undefined) {
      const min = vector(world.bounds.min);
      const max = vector(world.bounds.max);
      center = min.clone().add(max).multiplyScalar(0.5);
      floorY = min.y;
      gridSize = Math.max(10, max.x - min.x, max.z - min.z);
      const floorGeometry = buildGeometry(new THREE.PlaneGeometry(Math.max(1, max.x - min.x), Math.max(1, max.z - min.z)));
      const floorMaterial = buildMaterial(new THREE.MeshStandardMaterial({ color: '#202b32', roughness: 0.95, metalness: 0.05, side: THREE.DoubleSide }));
      const floor = new THREE.Mesh(floorGeometry, floorMaterial);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(center.x, floorY - 0.025, center.z);
      worldGroup.add(floor);
      const boundsGeometry = buildGeometry(new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z));
      const bounds = new THREE.Mesh(boundsGeometry, buildMaterial(new THREE.MeshBasicMaterial({ color: '#76909a', wireframe: true, transparent: true, opacity: 0.12 })));
      bounds.position.copy(center);
      worldGroup.add(bounds);
    }

    {
      const grid = new THREE.GridHelper(gridSize, Math.max(12, Math.round(gridSize)), '#547078', '#283941');
      grid.position.set(center.x, floorY, center.z);
      grid.visible = visible.grid;
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) {
        const lineMaterial = material as THREE.Material & { transparent?: boolean; opacity?: number; depthWrite?: boolean };
        lineMaterial.transparent = true;
        lineMaterial.opacity = 0.5;
        lineMaterial.depthWrite = false;
        counters.materialsCreated += 1;
      }
      counters.geometriesCreated += 1;
      worldGroup.add(grid);
    }

    if (world.colliders.length > 0) {
      const colliderGroup = new THREE.Group();
      colliderGroup.userData['probeCollider'] = true;
      colliderGroup.visible = visible.colliders;
      const solidColliders = world.colliders.filter((collider) => collider.solid);
      const nonSolidColliders = world.colliders.filter((collider) => !collider.solid);
      const transform = new THREE.Object3D();
      const addInstances = (colliders: typeof world.colliders, color: string, opacity: number): void => {
        if (colliders.length === 0) return;
        const geometry = buildGeometry(new THREE.BoxGeometry(1, 1, 1));
        const material = buildMaterial(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
        const instances = new THREE.InstancedMesh(geometry, material, colliders.length);
        colliders.forEach((collider, index) => {
          const min = vector(collider.bounds.min);
          const max = vector(collider.bounds.max);
          transform.position.copy(min).add(max).multiplyScalar(0.5);
          transform.scale.copy(max.sub(min));
          transform.updateMatrix();
          instances.setMatrixAt(index, transform.matrix);
        });
        instances.instanceMatrix.needsUpdate = true;
        colliderGroup.add(instances);
      };
      addInstances(solidColliders, '#90aeb2', 0.045);
      addInstances(nonSolidColliders, '#64747a', 0.018);

      const edgePairs: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
      const edgePositions: number[] = [];
      for (const collider of world.colliders) {
        const min = collider.bounds.min;
        const max = collider.bounds.max;
        const corners: Array<[number, number, number]> = [
          [min[0], min[1], min[2]], [max[0], min[1], min[2]],
          [min[0], max[1], min[2]], [max[0], max[1], min[2]],
          [min[0], min[1], max[2]], [max[0], min[1], max[2]],
          [min[0], max[1], max[2]], [max[0], max[1], max[2]],
        ];
        for (const [from, to] of edgePairs) {
          const first = corners[from];
          const second = corners[to];
          if (first === undefined || second === undefined) continue;
          edgePositions.push(...first, ...second);
        }
      }
      const edgeGeometry = buildGeometry(new THREE.BufferGeometry());
      edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
      edgeGeometry.computeBoundingSphere();
      const edgeMaterial = buildMaterial(new THREE.LineBasicMaterial({ color: '#8ca6a9', transparent: true, opacity: 0.62, depthWrite: false }));
      colliderGroup.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
      worldGroup.add(colliderGroup);
    }

    for (const label of world.labels ?? []) {
      const marker = new THREE.Mesh(
        buildGeometry(new THREE.RingGeometry(0.26, 0.32, 20)),
        buildMaterial(new THREE.MeshBasicMaterial({ color: '#e7b76c', side: THREE.DoubleSide, transparent: true, opacity: 0.8 })),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(vector(label.position));
      marker.position.y += 0.025;
      worldGroup.add(marker);
    }

    if (world.bounds !== undefined) {
      const min = vector(world.bounds.min);
      const max = vector(world.bounds.max);
      target.copy(min).add(max).multiplyScalar(0.5);
      const diagonal = max.clone().sub(min).length();
      radius = Math.max(6, diagonal * 0.72);
    } else {
      target.set(0, 0, 0);
      radius = 28;
    }
    setCameraPosition();
  };

  const trackById = (trackId: string | undefined): ProbeViewerTrack | undefined => data?.tracks.find((track) => track.id === trackId);

  const syncTrackPositions = (): void => {
    for (const objects of trackObjects) {
      const { track, actor, nose, hitbox, failure } = objects;
      const frame = track.trace.find((candidate) => candidate.tick === currentTick) ?? track.trace.filter((candidate) => candidate.tick <= currentTick).at(-1);
      const position = frame === undefined ? undefined : framePosition(frame);
      const isSelected = track.id === selectedTrack;
      objects.group.visible = visible.actors && position !== undefined;
      hitbox.visible = visible.aabbs && position !== undefined && frame?.actorBounds !== undefined;
      if (position !== undefined) {
        if (frame?.actorBounds !== undefined) {
          const min = vector(frame.actorBounds.min);
          const max = vector(frame.actorBounds.max);
          const size = max.clone().sub(min);
          actor.scale.set(Math.max(0.1, size.x / 0.56), Math.max(0.1, size.y / 1.74), Math.max(0.1, size.z / 0.56));
          actor.position.copy(min.clone().add(max).multiplyScalar(0.5));
          hitbox.position.copy(min.clone().add(max).multiplyScalar(0.5));
          hitbox.scale.copy(size);
        } else {
          actor.position.set(position[0], position[1] + 0.9, position[2]);
          actor.scale.set(1, 1, 1);
        }
        const yaw = frame?.yaw ?? 0;
        nose.position.set(0, actor.scale.y * 0.1, -actor.scale.z * 0.52);
        nose.rotation.y = 0;
        objects.group.rotation.y = yaw;
        actor.material = actor.material as THREE.MeshBasicMaterial;
        (actor.material as THREE.MeshBasicMaterial).opacity = isSelected ? 0.62 : 0.31;
      }
      if (failure !== undefined && track.failure !== undefined) failure.visible = currentTick >= track.failure.tick;
    }
  };

  const buildTracks = (tracks: readonly ProbeViewerTrack[]): void => {
    clearGroup(pathGroup, counters);
    clearGroup(actorGroup, counters);
    trackObjects = [];
    tracks.forEach((track, index) => {
      const color = track.color ?? palette[index % palette.length] ?? '#69d4bd';
      const color3 = new THREE.Color(color);
      const positions = track.trace.map(framePosition).filter((position): position is [number, number, number] => position !== undefined);
      if (positions.length > 1) {
        const lineGeometry = buildGeometry(new THREE.BufferGeometry().setFromPoints(positions.map((position) => vector(position))));
        const lineMaterial = buildMaterial(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
        const line = new THREE.Line(lineGeometry, lineMaterial);
        line.visible = visible.paths;
        pathGroup.add(line);
      }

      const group = new THREE.Group();
      const actor = new THREE.Mesh(
        buildGeometry(new THREE.CapsuleGeometry(0.28, 1.18, 4, 8)),
        buildMaterial(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide })),
      );
      const nose = new THREE.Mesh(
        buildGeometry(new THREE.ConeGeometry(0.11, 0.3, 5)),
        buildMaterial(new THREE.MeshBasicMaterial({ color: color3.clone().offsetHSL(0.02, 0, 0.08), transparent: true, opacity: 0.9 })),
      );
      nose.rotation.x = Math.PI / 2;
      group.add(actor, nose);
      actorGroup.add(group);
      const hitbox = new THREE.Mesh(
        buildGeometry(new THREE.BoxGeometry(1, 1, 1)),
        buildMaterial(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.86, wireframe: true, depthWrite: false })),
      );
      hitbox.visible = false;
      actorGroup.add(hitbox);

      let failure: THREE.Mesh | undefined;
      if (track.failure !== undefined) {
        const failureColor = failureColors[track.failure.kind] ?? '#ff526a';
        failure = new THREE.Mesh(
          buildGeometry(failureGeometry(track.failure.kind)),
          buildMaterial(new THREE.MeshBasicMaterial({ color: failureColor, transparent: true, opacity: 0.92, wireframe: false })),
        );
        const failureFrame = track.trace.find((frame) => frame.tick === track.failure?.tick);
        const location = track.failure.position ?? (failureFrame === undefined ? undefined : framePosition(failureFrame));
        if (location !== undefined) failure.position.copy(vector(location)).y += 0.44;
        actorGroup.add(failure);
      }

      trackObjects.push({ track, group, actor, nose, hitbox, failure });
    });
    syncTrackPositions();
  };

  const pickTrack = (event: PointerEvent): void => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const actors = trackObjects.map((item) => item.actor);
    const hit = raycaster.intersectObjects(actors, false)[0];
    if (hit?.object !== undefined) {
      const found = trackObjects.find((item) => item.actor === hit.object);
      if (found !== undefined) options.onPickTrack?.(found.track.id);
    }
  };

  listen(stage, 'pointerdown', ((event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    activeDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    stage.setPointerCapture(event.pointerId);
  }) as EventListener);
  listen(stage, 'pointermove', ((event: PointerEvent) => {
    if (activeDrag?.id !== event.pointerId) return;
    const dx = event.clientX - activeDrag.x;
    const dy = event.clientY - activeDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) activeDrag.moved = true;
    activeDrag.x = event.clientX;
    activeDrag.y = event.clientY;
    theta -= dx * 0.006;
    phi = THREE.MathUtils.clamp(phi - dy * 0.006, 0.08, Math.PI - 0.08);
    setCameraPosition();
  }) as EventListener);
  listen(stage, 'pointerup', ((event: PointerEvent) => {
    if (activeDrag?.id !== event.pointerId) return;
    const wasMoved = activeDrag.moved;
    activeDrag = undefined;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!wasMoved) pickTrack(event);
  }) as EventListener);
  listen(stage, 'pointercancel', (() => { activeDrag = undefined; }) as EventListener);
  listen(stage, 'contextmenu', ((event: MouseEvent) => event.preventDefault()) as EventListener);
  listen(stage, 'wheel', ((event: WheelEvent) => {
    event.preventDefault();
    radius = THREE.MathUtils.clamp(radius * Math.exp(event.deltaY * 0.001), 2.5, 600);
    setCameraPosition();
  }) as EventListener, { passive: false });

  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resize);
    observer.observe(stage);
    resizeCounters.activeResizeObservers = 1;
  } else {
    listen(window, 'resize', resize as EventListener);
  }
  resize();

  const render = (): void => {
    if (disposed) return;
    frameId = window.requestAnimationFrame(render);
    try {
      setCameraPosition();
      renderer.render(scene, camera);
    } catch (cause) {
      if (!errorReported) {
        errorReported = true;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        options.onRenderError?.(error);
      }
    }
  };
  frameId = window.requestAnimationFrame(render);

  const getResourceStats = (): ProbeViewerResourceStats => ({
    disposed,
    activeAnimationFrames: disposed ? 0 : 1,
    activeListeners: disposed ? 0 : listeners.length,
    activeResizeObservers: disposed ? 0 : resizeCounters.activeResizeObservers,
    geometriesCreated: counters.geometriesCreated,
    geometriesDisposed: counters.geometriesDisposed,
    materialsCreated: counters.materialsCreated,
    materialsDisposed: counters.materialsDisposed,
    tracks: disposed ? 0 : trackObjects.length,
  });

  const api: ProbeViewer = {
    setData(nextData): void {
      if (disposed) throw new Error('Cannot update a disposed ProbeViewer.');
      const sceneChanged = data?.scene !== nextData.scene;
      data = nextData;
      if (selectedTrack === undefined || !nextData.tracks.some((track) => track.id === selectedTrack)) selectedTrack = nextData.tracks[0]?.id;
      currentTick = Math.max(0, Math.min(currentTick, ...nextData.tracks.map((track) => track.trace.at(-1)?.tick ?? 0)));
      if (sceneChanged) buildWorld(nextData.scene);
      buildTracks(nextData.tracks);
    },
    loadPackage(pkg): void {
      api.setData({ scene: pkg.encoded.debugWorld, tracks: [packageTrack(pkg)] });
    },
    setTick(tick): void {
      if (disposed) return;
      const chosen = trackById(selectedTrack) ?? data?.tracks[0];
      const max = chosen?.trace.at(-1)?.tick ?? 0;
      currentTick = Math.max(0, Math.min(max, Math.round(tick)));
      syncTrackPositions();
    },
    getTick(): number { return currentTick; },
    focusAt(position, focusRadius = 10): void {
      if (disposed) return;
      target.copy(vector(position));
      radius = THREE.MathUtils.clamp(focusRadius, 2.5, 600);
      setCameraPosition();
    },
    selectTrack(trackId): void {
      if (disposed) return;
      selectedTrack = trackId;
      syncTrackPositions();
    },
    setVisibility(next): void {
      if (disposed) return;
      visible = { ...visible, ...next };
      for (const child of pathGroup.children) child.visible = visible.paths;
      for (const child of worldGroup.children) {
        if (child instanceof THREE.GridHelper) child.visible = visible.grid;
        else if (child.userData['probeCollider'] === true) child.visible = visible.colliders;
      }
      syncTrackPositions();
    },
    getResourceStats,
    dispose(): ProbeViewerResourceStats {
      if (disposed) return getResourceStats();
      disposed = true;
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
      resizeCounters.activeResizeObservers = 0;
      for (const item of listeners) item.target.removeEventListener(item.type, item.listener, item.options);
      listeners.length = 0;
      clearGroup(worldGroup, counters);
      clearGroup(pathGroup, counters);
      clearGroup(actorGroup, counters);
      scene.remove(worldGroup, pathGroup, actorGroup);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      stage.remove();
      trackObjects = [];
      data = undefined;
      return getResourceStats();
    },
  };

  if (options.data !== undefined) api.setData(options.data);
  return api;
}
