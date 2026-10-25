import {canonicalHash} from '@probelab/core';
import type {DataDTO} from '@probelab/core';
import type {AuditMap,AuditDriver,RouteResult} from '@probelab/audit';
import {sandboxAdapter,createSandboxScenario} from '@probelab/sandbox';
export function createDemoAudit(id:string){
 const scenario=createSandboxScenario({seed:'public-audit-demo',scenario:'healthy'});
 const map:AuditMap={id,sourceHash:canonicalHash({id,world:scenario.world as unknown as DataDTO}),radius:.25,height:1.4,eyeHeight:1.2,surfaces:scenario.world.colliders.map(c=>({...c,visible:true,bulletSolid:c.solid,exactVisual:true})),spawns:[[0,.02,0]],routes:[{id:'wall-crossing',label:'PRESET: route through solid wall',kind:'spawn-route',start:[0,.02,0],goal:[5,0,0],waypoints:[[5,0,0]],graphConnected:false}]};
 if(id==='demo-a')map.spawns.push([3.2,.02,0]);
 if(id==='demo-b')map.surfaces.push({id:'PRESET-visible-nonsolid-wall',bounds:{min:[1,0,-1],max:[1.2,3,1]},solid:false,bulletSolid:false,visible:true,exactVisual:true});
 const driver:AuditDriver={run(route,jumpRecovery,maxTicks,cancelled){let state=sandboxAdapter.createInitialState(scenario.world,scenario.config,{position:route.start,yaw:0});const frames:RouteResult['frames']=[];let closest=Infinity,stalled=0,lastX=state.position[0];for(let tick=1;tick<=maxTicks;tick++){if(cancelled())break;const dx=route.goal[0]-state.position[0],dz=route.goal[2]-state.position[2],d=Math.hypot(dx,dz);closest=Math.min(closest,d);if(d<.5&&state.onGround)return {arrived:true,reason:'arrived-and-landed',frames,closestDistance:d,stalledTicks:stalled};const command={dx:dx/Math.max(d,.01),dz:dz/Math.max(d,.01),jump:jumpRecovery&&tick%90<5,crouch:false,sprint:false,yaw:0,pitch:0};state=sandboxAdapter.step(state,command,scenario.world,scenario.config,1/60).state;frames.push({tick,position:[...state.position],command,state:sandboxAdapter.encodeState(state) as DataDTO});if(tick%60===0){stalled=Math.abs(state.position[0]-lastX)<.05?stalled+60:0;lastX=state.position[0];if(stalled>=240)break;}}return {arrived:false,reason:cancelled()?'cancelled':'blocked-demo-wall',frames,closestDistance:closest,stalledTicks:stalled};}};
 return {map,driver};
}
