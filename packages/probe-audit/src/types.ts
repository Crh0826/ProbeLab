import type { AABB, DataDTO } from '@probelab/core';
export type Point = [number, number, number];
export interface Surface { id: string; bounds: AABB; visible: boolean; solid: boolean; bulletSolid: boolean; exactVisual: boolean; note?: string }
export interface Route { id: string; label: string; kind: 'spawn-route' | 'stairs-ramp' | 'jump-landing'; start: Point; goal: Point; waypoints: Point[]; graphConnected: boolean }
export interface AuditMap { id: string; surfaces: Surface[]; spawns: Point[]; routes: Route[]; radius: number; height: number; eyeHeight: number; sourceHash: string }
export interface AuditFrame { tick: number; position: Point; command: DataDTO; state: DataDTO }
export interface RouteResult { arrived: boolean; reason: string; frames: AuditFrame[]; closestDistance: number; stalledTicks: number; rawFailure?: string }
export interface AuditDriver { run(route: Route, jumpRecovery: boolean, maxTicks: number, cancelled: () => boolean): RouteResult }
export interface AuditIssue { id: string; rule: string; severity: 'error' | 'review'; title: string; position: Point; surfaceIds: string[]; detail: DataDTO; routeId?: string }
export interface AuditEvidence { route: Route; attempts: RouteResult[] }
export interface AuditReport { schemaVersion: 1; kind: 'probelab-map-audit'; mapId: string; sourceHash: string; issues: AuditIssue[]; evidence: AuditEvidence[]; checked: { surfaces: number; spawns: number; rays: number; routes: number; ticks: number }; incomplete: boolean; limits: { maxRoutes: number; maxTicksPerAttempt: number }; limitations: string[]; contentHash: string }
