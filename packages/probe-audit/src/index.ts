import { canonicalHash } from '@probelab/core';
import type { AABB } from '@probelab/core';
import type { AuditDriver, AuditIssue, AuditMap, AuditReport, Point, Surface } from './types.js';
export * from './types.js';
export { importAuditReport } from './import.js';
const distance=(a:Point,b:Point)=>Math.hypot(...a.map((n,i)=>n-b[i]!));
const centre=(b:AABB):Point=>b.min.map((n,i)=>Number.isFinite(n)&&Number.isFinite(b.max[i])?(n+b.max[i]!)/2:0) as Point;
function valid(s:Surface):boolean{return s.bounds.min.every((v,i)=>Number.isFinite(v)&&Number.isFinite(s.bounds.max[i])&&v<s.bounds.max[i]!);}
function overlap(a:AABB,b:AABB):boolean{return a.min.every((n,i)=>Math.min(a.max[i]!,b.max[i]!)-Math.max(n,b.min[i]!)>.002);}
export function rayDistance(origin:Point,end:Point,box:AABB):number|undefined {
  const length=distance(origin,end);if(length<1e-6)return;
  let enter=0,exit=length;
  for(let i=0;i<3;i++){
    const d=(end[i]!-origin[i]!)/length;
    if(Math.abs(d)<1e-10){if(origin[i]!<box.min[i]!||origin[i]!>box.max[i]!)return;continue;}
    let a=(box.min[i]!-origin[i]!)/d,b=(box.max[i]!-origin[i]!)/d;if(a>b)[a,b]=[b,a];
    enter=Math.max(enter,a);exit=Math.min(exit,b);if(enter>exit)return;
  }
  return enter;
}
export async function auditMap(map:AuditMap,driver:AuditDriver,options:{maxRoutes?:number;maxTicksPerAttempt?:number;cancelled?:()=>boolean;yield?:()=>Promise<void>;progress?:(done:number,total:number)=>void}={}):Promise<AuditReport>{
  const maxRoutes=options.maxRoutes??24,maxTicks=options.maxTicksPerAttempt??1200,cancelled=options.cancelled??(()=>false);
  if(!Number.isInteger(maxRoutes)||maxRoutes<1||maxRoutes>256||!Number.isInteger(maxTicks)||maxTicks<1||maxTicks>3600)throw new RangeError('Invalid audit budget');
  const issues:AuditIssue[]=[],evidence:AuditReport['evidence']=[],checked={surfaces:0,spawns:0,rays:0,routes:0,ticks:0};
  const add=(issue:Omit<AuditIssue,'id'>)=>issues.push({...issue,id:canonicalHash({map:map.id,...issue}).slice(0,20)});
  const surfaces=map.surfaces.filter(s=>{checked.surfaces++;if(valid(s))return true;add({rule:'invalid-geometry',severity:'error',title:'源几何尺寸为零、反向或非有限',position:centre(s.bounds),surfaceIds:[s.id],detail:{bounds:{min:s.bounds.min.map(String),max:s.bounds.max.map(String)}}});return false;});
  for(const [index,p] of map.spawns.entries()){
    checked.spawns++;
    const actor={min:[p[0]-map.radius,p[1],p[2]-map.radius] as Point,max:[p[0]+map.radius,p[1]+map.height,p[2]+map.radius] as Point};
    const blocked=surfaces.filter(s=>s.solid&&overlap(actor,s.bounds));
    if(blocked.length)add({rule:'spawn-overlap',severity:'error',title:'出生点角色体积与碰撞体重叠',position:p,surfaceIds:blocked.map(s=>s.id),detail:{spawn:index,actor:actor as unknown as import('@probelab/core').DataDTO}});
    const support=surfaces.some(s=>s.solid&&s.bounds.max[1]<=p[1]+.05&&s.bounds.max[1]>=p[1]-1&&p[0]>s.bounds.min[0]-map.radius&&p[0]<s.bounds.max[0]+map.radius&&p[2]>s.bounds.min[2]-map.radius&&p[2]<s.bounds.max[2]+map.radius);
    if(!support)add({rule:'spawn-support',severity:'review',title:'出生点下方一米内未采到支撑面',position:p,surfaceIds:[],detail:{spawn:index,note:'可能是设计中的空中出生点，需要复核'}});
  }
  // Compare only exact, axis-aligned visible boxes. Curved/rotated surfaces cannot establish visual equality from AABBs.
  const candidates=surfaces.filter(s=>s.visible&&s.exactVisual&&s.bounds.max[1]-s.bounds.min[1]>1.2);
  const origins=map.spawns.slice(0,12).map(p=>[p[0],p[1]+map.eyeHeight,p[2]] as Point);
  for(const surface of candidates){
    if(cancelled())break;
    const end=centre(surface.bounds);let observed=false;
    for(const origin of origins){
      if(distance(origin,end)>45)continue;checked.rays++;
      const visual=surfaces.filter(s=>s.visible&&s.exactVisual).map(s=>({s,t:rayDistance(origin,end,s.bounds)})).filter(v=>v.t!==undefined&&v.t>.02).sort((a,b)=>a.t!-b.t!)[0];
      if(visual?.s.id!==surface.id)continue;
      const hit=(field:'solid'|'bulletSolid')=>surfaces.filter(s=>s[field]).map(s=>({s,t:rayDistance(origin,end,s.bounds)})).filter(v=>v.t!==undefined&&v.t>.02).sort((a,b)=>a.t!-b.t!)[0];
      const collision=hit('solid'),bullet=hit('bulletSolid');
      if((!collision||Math.abs(collision.t!-visual.t!)>.2)||(!bullet||Math.abs(bullet.t!-visual.t!)>.2)){
        add({rule:'visual-collision-shot',severity:'review',title:'可见表面与移动/射击遮挡采样不一致',position:end,surfaceIds:[surface.id,...[collision?.s.id,bullet?.s.id].filter((s):s is string=>!!s)],detail:{origin,end,visualDistance:visual.t!,collisionDistance:collision?.t??null,bulletDistance:bullet?.t??null,note:'装饰、玻璃和设计中的可穿透表面可能合理；不是像素级图像判断'}});observed=true;break;
      }
    }
    if(observed&&issues.length>300)break;
  }
  const selected=map.routes.slice(0,maxRoutes);
  const invisibleSeen=new Set<string>();
  for(const origin of origins)for(const route of selected){
    const end:Point=[route.goal[0],route.goal[1]+map.eyeHeight,route.goal[2]];checked.rays++;
    const hits=surfaces.filter(s=>s.solid).map(s=>({s,t:rayDistance(origin,end,s.bounds)})).filter(h=>h.t!==undefined&&h.t>.02).sort((a,b)=>a.t!-b.t!);
    const hit=hits[0];if(!hit||invisibleSeen.has(hit.s.id))continue;
    const visible=surfaces.filter(s=>s.visible&&s.exactVisual).map(s=>rayDistance(origin,end,s.bounds)).filter((t):t is number=>t!==undefined&&t>.02).sort((a,b)=>a-b)[0];
    if(!hit.s.visible&&(visible===undefined||Math.abs(visible-hit.t!)>.2)){
      invisibleSeen.add(hit.s.id);add({rule:'invisible-collider',severity:'review',title:'射线先命中隐藏碰撞盒，需对照实际模型复核',position:centre(hit.s.bounds),surfaceIds:[hit.s.id],detail:{origin,end,collisionDistance:hit.t!,visualDistance:visible??null,note:'复杂模型的保守碰撞近似可能合理，不自动判成隐形墙'}});
    }
  }
  for(const route of selected){
    if(cancelled())break;
    const attempts=[driver.run(route,route.kind==='jump-landing',maxTicks,cancelled)];
    if(!attempts[0]!.arrived&&!cancelled())attempts.push(driver.run(route,true,maxTicks,cancelled));
    checked.routes++;checked.ticks+=attempts.reduce((sum,a)=>sum+a.frames.length,0);evidence.push({route,attempts});
    if(!attempts.some(a=>a.arrived)&&!cancelled()){
      const last=attempts.at(-1)!;
      add({rule:route.kind,severity:'review',title:route.kind==='stairs-ramp'?'楼梯/斜坡定向通行未完成':route.kind==='jump-landing'?'跳跃落点定向通行未完成':'出生点到区域的定向通行未完成',position:last.frames.at(-1)?.position??route.start,surfaceIds:[],routeId:route.id,detail:{graphConnected:route.graphConnected,closestDistance:last.closestDistance,stalledTicks:last.stalledTicks,reason:last.reason,note:'保存实际模拟轨迹；局部寻路/控制器失败不等于证明整个区域不可达'}});
    }
    options.progress?.(checked.routes,selected.length);await options.yield?.();
  }
  const body:Omit<AuditReport,'contentHash'>={schemaVersion:1,kind:'probelab-map-audit',mapId:map.id,sourceHash:map.sourceHash,issues,evidence,checked,incomplete:cancelled()||checked.routes<map.routes.length,limits:{maxRoutes,maxTicksPerAttempt:maxTicks},limitations:['只覆盖已列出的定向路径和射线，不证明整图可达。','弧形/旋转/复杂模型视觉需在实际渲染现场复核。','review是候选，不自动当成游戏Bug或自动改地图。']};
  return {...body,contentHash:canonicalHash(body)};
}
