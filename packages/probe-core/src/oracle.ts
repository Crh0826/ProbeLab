import { compareCodePoints } from './canonical.js';
import type { FailureKind, FailureSignature, Inspection, OracleConfig, ProbeAdapter } from './types.js';

export interface OracleHit { kind: FailureKind; target: string; detail: Record<string, string | number | boolean | null | Array<number>> }

export interface InspectionCache {
  expectedPaths: string[];
  validatedAABBs: WeakSet<object>;
  validatedColliders: WeakSet<object>;
  validatedLists: WeakMap<object, boolean>;
}

export function createInspectionCache<State>(adapter: ProbeAdapter<State>): InspectionCache {
  return {
    expectedPaths: [...adapter.descriptor.numericPaths].sort(compareCodePoints),
    validatedAABBs: new WeakSet(), validatedColliders: new WeakSet(), validatedLists: new WeakMap(),
  };
}

export function inspectAndValidate<State>(adapter: ProbeAdapter<State>, state: State, world: unknown, config: unknown, oracle: OracleConfig, cache: InspectionCache): Inspection {
  const inspection = adapter.inspect(state, world, config);
  if (!inspection || !Array.isArray(inspection.numericFields)) throw new TypeError('adapter.inspect must return numericFields');
  let fields = inspection.numericFields;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field || typeof field.path !== 'string' || !field.path.startsWith('/') || typeof field.value !== 'number') throw new TypeError('invalid numeric field');
    if (index > 0 && compareCodePoints(fields[index - 1]?.path ?? '', field.path) > 0) {
      fields = [...fields].sort((a, b) => compareCodePoints(a.path, b.path));
      break;
    }
  }
  if (fields.length !== cache.expectedPaths.length) throw new TypeError(`numericFields must exactly match descriptor.numericPaths (${cache.expectedPaths.join(', ')})`);
  for (let index = 0; index < fields.length; index++) {
    if (fields[index]?.path !== cache.expectedPaths[index]) throw new TypeError(`numericFields must exactly match descriptor.numericPaths (${cache.expectedPaths.join(', ')})`);
  }
  // Numeric checks run first; do not let NaN geometry obscure a state fault.
  for (const field of fields) if (!Number.isFinite(field.value)) return { ...inspection, numericFields: fields };

  if (inspection.position) assertVector(inspection.position, 'position');
  if (inspection.actorBounds) assertAABB(inspection.actorBounds, 'actorBounds');
  if (inspection.worldBounds && !cache.validatedAABBs.has(inspection.worldBounds)) {
    assertAABB(inspection.worldBounds, 'worldBounds');
    if (Object.isFrozen(inspection.worldBounds)) cache.validatedAABBs.add(inspection.worldBounds);
  }
  const colliders = inspection.colliders ?? EMPTY_COLLIDERS;
  if (!Array.isArray(colliders)) throw new TypeError('colliders must be an array');
  let hasSolid = cache.validatedLists.get(colliders);
  if (hasSolid === undefined) {
    const ids = new Set<string>(); hasSolid = false;
    for (const collider of colliders) {
      if (!collider || typeof collider.id !== 'string' || !collider.id || ids.has(collider.id)) throw new TypeError('collider IDs must be unique non-empty strings');
      ids.add(collider.id);
      if (!cache.validatedColliders.has(collider)) {
        if (typeof collider.solid !== 'boolean') throw new TypeError(`collider ${collider.id} has invalid solid flag`);
        if (!cache.validatedAABBs.has(collider.bounds)) {
          assertAABB(collider.bounds, `collider ${collider.id}`);
          if (Object.isFrozen(collider.bounds)) cache.validatedAABBs.add(collider.bounds);
        }
        if (Object.isFrozen(collider)) cache.validatedColliders.add(collider);
      }
      if (collider.solid) hasSolid = true;
    }
    if (Object.isFrozen(colliders)) cache.validatedLists.set(colliders, hasSolid);
  }
  if (oracle.enabledAxes.length > 0 && !inspection.worldBounds) throw new TypeError('enabled bounds oracle requires worldBounds');
  if (oracle.boundsMode === 'position' && oracle.enabledAxes.length > 0 && !inspection.position) throw new TypeError('position bounds policy requires position');
  if (oracle.boundsMode === 'actor' && oracle.enabledAxes.length > 0 && !inspection.actorBounds) throw new TypeError('actor bounds policy requires actorBounds');
  if (hasSolid && !inspection.actorBounds) throw new TypeError('solid colliders require actorBounds');
  return { ...inspection, numericFields: fields, colliders };
}

export function firstOracleHit(inspection: Inspection, oracle: OracleConfig, invalidStart = false): OracleHit | undefined {
  for (const field of inspection.numericFields) {
    if (!Number.isFinite(field.value)) {
      const kind: FailureKind = invalidStart ? 'invalid-start' : 'non-finite-state';
      const numberType = Number.isNaN(field.value) ? 'NaN' : field.value > 0 ? '+Infinity' : '-Infinity';
      return { kind, target: invalidStart ? `non-finite:${field.path}:${numberType}` : `${field.path}:${numberType}`, detail: { rule: 'non-finite-state', path: field.path, numberType } };
    }
  }
  const out = boundsHit(inspection, oracle);
  if (out) return invalidStart ? { ...out, kind: 'invalid-start', target: `out-of-bounds:${out.target}` } : out;
  const penetration = penetrationHit(inspection, oracle.penetrationEpsilon);
  if (penetration) return invalidStart ? { ...penetration, kind: 'invalid-start', target: `penetration:${penetration.target}` } : penetration;
  return undefined;
}

const EMPTY_COLLIDERS = Object.freeze([]) as unknown as NonNullable<Inspection['colliders']>;

export function signature(kind: FailureKind, target: string): FailureSignature { return { kind, target }; }

function boundsHit(inspection: Inspection, oracle: OracleConfig): OracleHit | undefined {
  if (!inspection.worldBounds || oracle.enabledAxes.length === 0) return undefined;
  const bounds = inspection.worldBounds;
  const position = oracle.boundsMode === 'position' ? inspection.position : undefined;
  const actor = oracle.boundsMode === 'actor' ? inspection.actorBounds : undefined;
  if (oracle.boundsMode === 'position' && !position || oracle.boundsMode === 'actor' && !actor) return undefined;
  const axes = AXES;
  for (let axis = 0; axis < 3; axis++) {
    if (!oracle.enabledAxes.includes(axes[axis] ?? 'x')) continue;
    const tolerance = oracle.tolerance[axis] ?? 0;
    const lowLimit = bounds.min[axis] ?? 0; const highLimit = bounds.max[axis] ?? 0;
    const valueLow = position ? position[axis] ?? 0 : actor?.min[axis] ?? 0;
    const valueHigh = position ? position[axis] ?? 0 : actor?.max[axis] ?? 0;
    if (valueLow < lowLimit - tolerance) return { kind: 'out-of-bounds', target: `${axes[axis]}:negative`, detail: { axis: axes[axis] ?? 'x', direction: 'negative', boundary: lowLimit, value: valueLow, tolerance } };
    if (valueHigh > highLimit + tolerance) return { kind: 'out-of-bounds', target: `${axes[axis]}:positive`, detail: { axis: axes[axis] ?? 'x', direction: 'positive', boundary: highLimit, value: valueHigh, tolerance } };
  }
  return undefined;
}

export function validateOracleConfig(oracle: OracleConfig): void {
  if (!oracle || (oracle.boundsMode !== 'position' && oracle.boundsMode !== 'actor')) throw new TypeError('invalid oracle boundsMode');
  if (!Array.isArray(oracle.enabledAxes) || new Set(oracle.enabledAxes).size !== oracle.enabledAxes.length || oracle.enabledAxes.some((axis) => !['x', 'y', 'z'].includes(axis))) throw new TypeError('oracle enabledAxes must be unique x/y/z axes');
  if (!Array.isArray(oracle.tolerance) || oracle.tolerance.length !== 3 || oracle.tolerance.some((value) => !Number.isFinite(value) || value < 0)) throw new TypeError('oracle tolerance must contain three finite non-negative values');
  if (!Number.isFinite(oracle.penetrationEpsilon) || oracle.penetrationEpsilon < 0) throw new TypeError('oracle penetrationEpsilon must be finite and non-negative');
}

function penetrationHit(inspection: Inspection, epsilon: number): OracleHit | undefined {
  const actor = inspection.actorBounds;
  if (!actor) return undefined;
  let bestId: string | undefined;
  let bestX = 0; let bestY = 0; let bestZ = 0; let bestDepth = 0;
  for (const collider of inspection.colliders ?? []) {
    if (!collider.solid) continue;
    const x = Math.min(actor.max[0], collider.bounds.max[0]) - Math.max(actor.min[0], collider.bounds.min[0]);
    const y = Math.min(actor.max[1], collider.bounds.max[1]) - Math.max(actor.min[1], collider.bounds.min[1]);
    const z = Math.min(actor.max[2], collider.bounds.max[2]) - Math.max(actor.min[2], collider.bounds.min[2]);
    if (x > epsilon && y > epsilon && z > epsilon && (bestId === undefined || compareCodePoints(collider.id, bestId) < 0)) {
      bestId = collider.id; bestX = x; bestY = y; bestZ = z; bestDepth = Math.min(x, y, z);
    }
  }
  return bestId === undefined ? undefined : {
    kind: 'penetration', target: bestId,
    detail: { colliderId: bestId, axisDepths: [bestX, bestY, bestZ], depth: bestDepth, epsilon },
  };
}

const AXES = ['x', 'y', 'z'] as const;

function assertVector(value: number[], name: string): asserts value is [number, number, number] {
  if (value.length !== 3 || value.some((item) => !Number.isFinite(item))) throw new TypeError(`${name} must have three finite values`);
}
function assertAABB(value: { min: number[]; max: number[] }, name: string): void {
  assertVector(value.min, `${name}.min`); assertVector(value.max, `${name}.max`);
  for (let axis = 0; axis < 3; axis++) if ((value.min[axis] ?? 0) > (value.max[axis] ?? 0)) throw new TypeError(`${name} min exceeds max`);
}

