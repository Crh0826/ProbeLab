import { assertDataDTO, canonicalHash } from '@probelab/core';
import type { AuditReport, Point } from './types.js';
const point=(v:unknown):v is Point=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
/** Data-only report import. A content hash is integrity, never a signature of a trusted source. */
export function importAuditReport(text:string):AuditReport {
  if(new TextEncoder().encode(text).length>32*1024*1024)throw new RangeError('Audit report exceeds 32MiB');
  const raw:unknown=JSON.parse(text);assertDataDTO(raw,{maxNodes:3_000_000});const report=raw as unknown as AuditReport;
  if(report.kind!=='probelab-map-audit'||report.schemaVersion!==1||typeof report.mapId!=='string'||typeof report.sourceHash!=='string'||!Array.isArray(report.issues)||report.issues.length>10000||!Array.isArray(report.evidence)||report.evidence.length>256||!report.limits||!Number.isInteger(report.limits.maxTicksPerAttempt)||report.limits.maxTicksPerAttempt<1||report.limits.maxTicksPerAttempt>3600)throw new TypeError('Invalid audit report');
  if(!report.checked||!['surfaces','spawns','rays','routes','ticks'].every(k=>Number.isSafeInteger(report.checked[k as keyof typeof report.checked])&&report.checked[k as keyof typeof report.checked]>=0)||typeof report.incomplete!=='boolean'||!Array.isArray(report.limitations)||!report.limitations.every(s=>typeof s==='string')||!Number.isInteger(report.limits.maxRoutes)||report.limits.maxRoutes<1||report.limits.maxRoutes>256)throw new TypeError('Invalid audit statistics or limits');
  for(const i of report.issues)if(!point(i.position)||typeof i.id!=='string'||typeof i.rule!=='string'||typeof i.title!=='string'||!['error','review'].includes(i.severity)||!Array.isArray(i.surfaceIds)||!i.surfaceIds.every(s=>typeof s==='string'))throw new TypeError('Invalid issue');
  for(const e of report.evidence){
    const r=e.route;if(!r||!point(r.start)||!point(r.goal)||!Array.isArray(r.waypoints)||r.waypoints.length>10000||!r.waypoints.every(point)||!['spawn-route','stairs-ramp','jump-landing'].includes(r.kind)||typeof r.id!=='string'||!Array.isArray(e.attempts)||e.attempts.length>2)throw new TypeError('Invalid route');
    for(const a of e.attempts)if(typeof a.arrived!=='boolean'||typeof a.reason!=='string'||!Number.isFinite(a.closestDistance)||!Number.isSafeInteger(a.stalledTicks)||a.stalledTicks<0||!Array.isArray(a.frames)||a.frames.length>3600||!a.frames.every(f=>Number.isInteger(f.tick)&&f.tick>0&&point(f.position)))throw new TypeError('Invalid trace');
  }
  if(report.debugMap&&(!Array.isArray(report.debugMap.surfaces)||report.debugMap.surfaces.length>20000||!report.debugMap.surfaces.every(s=>typeof s.id==='string'&&point(s.bounds?.min)&&point(s.bounds?.max)&&s.bounds.min.every((n,i)=>n<s.bounds.max[i]!)&&['visible','solid','bulletSolid','exactVisual'].every(k=>typeof s[k as keyof typeof s]==='boolean'))))throw new TypeError('Invalid debug map snapshot');
  const {contentHash,...body}=report;if(canonicalHash(body)!==contentHash)throw new TypeError('Audit report hash mismatch');return report;
}
