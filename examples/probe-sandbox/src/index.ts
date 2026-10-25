import {assertDataDTO,assertStateDTO,canonicalHash,createRandomSource} from '@probelab/core';
import type {AABB,Collider,CommandStrategy,DataDTO,OracleConfig,ProbeAdapter,SimulationDescriptor,StateDTO} from '@probelab/core';
import {SANDBOX_IMPLEMENTATION_HASH} from './build-info.js';
export interface SandboxState {position:[number,number,number];velocity:[number,number,number];yaw:number;pitch:number;height:number;onGround:boolean}
export interface SandboxCommand {dx:number;dz:number;jump:boolean;crouch:boolean;sprint:boolean;yaw:number;pitch:number}
export interface SandboxWorld {mapId:string;bounds:AABB;colliders:Collider[];floorEnd:number;demoInjection:string}
const parameters={gravity:9,walkSpeed:3,sprintSpeed:5,crouchSpeed:1.5,jumpSpeed:4.5,standHeight:1.4,crouchHeight:.9,radius:.25};
export interface SandboxConfig {fault:'healthy'|'drop'|'penetration'|'non-finite';demoInjection:boolean;oracle:OracleConfig;parameters:typeof parameters}
const paths=['/position/0','/position/1','/position/2','/velocity/0','/velocity/1','/velocity/2','/yaw','/pitch','/height'];
const oracle:OracleConfig={boundsMode:'actor',enabledAxes:['x','y','z'],tolerance:[.01,.01,.01],penetrationEpsilon:.001};
const dto=(v:unknown):DataDTO=>{assertDataDTO(v);return JSON.parse(JSON.stringify(v)) as DataDTO;};
const finite=(v:unknown,name:string):number=>{if(typeof v!=='number'||!Number.isFinite(v))throw new TypeError(name+' must be finite');return v;};
function vector(v:unknown,name:string):[number,number,number]{if(!Array.isArray(v)||v.length!==3)throw new TypeError(name+' must have 3 components');return [finite(v[0],name),finite(v[1],name),finite(v[2],name)];}
function bounds(v:unknown):AABB{const r=v as AABB,min=vector(r?.min,'AABB.min'),max=vector(r?.max,'AABB.max');if(min.some((n,i)=>n>=max[i]!))throw new TypeError('Invalid AABB extents');return {min,max};}
function world(v:unknown):SandboxWorld{
  dto(v);const w=v as SandboxWorld;if(typeof w?.mapId!=='string'||typeof w.demoInjection!=='string'||!Array.isArray(w.colliders)||w.colliders.length>1000)throw new TypeError('Invalid sandbox world');
  const seen=new Set<string>();for(const c of w.colliders){if(typeof c.id!=='string'||seen.has(c.id)||typeof c.solid!=='boolean')throw new TypeError('Invalid sandbox collider');seen.add(c.id);bounds(c.bounds);}
  bounds(w.bounds);finite(w.floorEnd,'floorEnd');return dto(w) as unknown as SandboxWorld;
}
function config(v:unknown):SandboxConfig{dto(v);const c=v as SandboxConfig;if(!['healthy','drop','penetration','non-finite'].includes(c?.fault)||typeof c.demoInjection!=='boolean'||!c.oracle||canonicalHash(c.parameters)!==canonicalHash(parameters))throw new TypeError('Invalid sandbox config');return dto(v) as unknown as SandboxConfig;}
function command(v:unknown):SandboxCommand{
  dto(v);const c=v as SandboxCommand;for(const k of ['dx','dz','yaw','pitch'] as const)finite(c[k],k);
  for(const k of ['jump','crouch','sprint'] as const)if(typeof c[k]!=='boolean')throw new TypeError('Invalid '+k);
  if(Math.abs(c.dx)>1||Math.abs(c.dz)>1)throw new TypeError('Command direction out of range');return {...c};
}
function encodeNumber(v:number):StateDTO {return Number.isFinite(v)?v:{$probeNumber:Number.isNaN(v)?'NaN':v>0?'+Infinity':'-Infinity'};}
function decodeNumber(v:StateDTO):number {if(typeof v==='number')return v;const tag=(v as {$probeNumber?:string})?.$probeNumber;if(tag==='NaN')return NaN;if(tag==='+Infinity')return Infinity;if(tag==='-Infinity')return -Infinity;throw new TypeError('Invalid state number');}
const clone=(s:SandboxState):SandboxState=>({...s,position:[...s.position],velocity:[...s.velocity]});
export function createSandboxAdapter(fixed=false):ProbeAdapter<SandboxState>{
  const descriptor:SimulationDescriptor={protocolVersion:1,adapterId:'probelab-sandbox',adapterVersion:'1',simulationVersion:fixed?'sandbox-fixed-v1':'sandbox-defects-v1',implementationHash:canonicalHash({source:SANDBOX_IMPLEMENTATION_HASH,model:'independent-aabb-linear-gravity-v1',fixed}),buildId:'sandbox-'+(fixed?'fixed':'defects')+'-'+SANDBOX_IMPLEMENTATION_HASH.slice(0,16),stateVersion:'1',commandVersion:'1',worldVersion:'1',configVersion:'1',startVersion:'1',tickRate:60,coordinateSystem:'right-handed Y-up; feet reference',units:'metres, seconds, radians',numericPaths:paths,oracleVersion:'probe-oracle-v1'};
  return {
    descriptor,encodeWorld:v=>dto(world(v)),decodeWorld:world,encodeConfig:v=>dto(config(v)),decodeConfig:config,
    encodeStart:v=>{const s=v as {position:unknown};return {position:vector(s?.position,'start.position')};},
    decodeStart:v=>({position:vector((v as {position:unknown})?.position,'start.position')}),
    encodeState:s=>({position:s.position.map(encodeNumber),velocity:s.velocity.map(encodeNumber),yaw:encodeNumber(s.yaw),pitch:encodeNumber(s.pitch),height:encodeNumber(s.height),onGround:s.onGround}),
    decodeState:data=>{assertStateDTO(data,descriptor);const s=data as {position:StateDTO[];velocity:StateDTO[];yaw:StateDTO;pitch:StateDTO;height:StateDTO;onGround:boolean};if(!Array.isArray(s.position)||s.position.length!==3||!Array.isArray(s.velocity)||s.velocity.length!==3||typeof s.onGround!=='boolean')throw new TypeError('Invalid sandbox state');return {position:s.position.map(decodeNumber) as [number,number,number],velocity:s.velocity.map(decodeNumber) as [number,number,number],yaw:decodeNumber(s.yaw),pitch:decodeNumber(s.pitch),height:decodeNumber(s.height),onGround:s.onGround};},
    encodeCommand:v=>dto(command(v)),decodeCommand:command,
    getOracleConfig:v=>(v as SandboxConfig).oracle,
    toDebugWorld:v=>{const w=v as SandboxWorld;return {mapId:w.mapId,coordinateSystem:descriptor.coordinateSystem,units:descriptor.units,bounds:w.bounds,colliders:w.colliders,metadata:{demoInjection:w.demoInjection,model:'Independent toy simulation, not FPS movement'}};},
    coverageCapacity:()=>96,
    createInitialState:(_w,c,start)=>({position:vector((start as {position:unknown}).position,'start'),velocity:[0,0,0],yaw:0,pitch:0,height:(c as SandboxConfig).parameters.standHeight,onGround:true}),
    cloneState:clone,
    step:(input,raw,w,c,dt)=>{
      const cmd=raw as SandboxCommand,scene=w as SandboxWorld,cfg=c as SandboxConfig,s=clone(input),p=cfg.parameters,r=p.radius;
      s.yaw=cmd.yaw;s.pitch=cmd.pitch;s.height=cmd.crouch?p.crouchHeight:p.standHeight;
      const speed=cmd.sprint?p.sprintSpeed:cmd.crouch?p.crouchSpeed:p.walkSpeed;s.velocity[0]=cmd.dx*speed;s.velocity[2]=cmd.dz*speed;
      if(cmd.jump&&s.onGround){s.velocity[1]=p.jumpSpeed;s.onGround=false;}s.velocity[1]-=p.gravity*dt;
      for(const axis of [0,2] as const){let next=s.position[axis]+s.velocity[axis]*dt;
        for(const collider of scene.colliders){if(!collider.solid||collider.bounds.max[1]<=s.position[1]+.001)continue;
          const other=axis===0?2:0;if(s.position[other]+r<=collider.bounds.min[other]||s.position[other]-r>=collider.bounds.max[other]||s.position[1]+s.height<=collider.bounds.min[1])continue;
          if(s.velocity[axis]>0&&s.position[axis]+r<=collider.bounds.min[axis]+.001&&next+r>collider.bounds.min[axis])next=collider.bounds.min[axis]-r-.0001;
          if(s.velocity[axis]<0&&s.position[axis]-r>=collider.bounds.max[axis]-.001&&next-r<collider.bounds.max[axis])next=collider.bounds.max[axis]+r+.0001;
        }s.position[axis]=next;
      }
      const nextY=s.position[1]+s.velocity[1]*dt;
      if(s.position[0]-r<scene.floorEnd&&nextY<0&&s.velocity[1]<0){s.position[1]=0;s.velocity[1]=0;s.onGround=true;}else{s.position[1]=nextY;s.onGround=false;}
      if(!fixed&&cfg.demoInjection&&cfg.fault==='penetration'&&s.position[0]>1&&cmd.sprint&&cmd.crouch)s.position[0]=3.2;
      if(!fixed&&cfg.demoInjection&&cfg.fault==='non-finite'&&s.position[0]>.5&&cmd.sprint&&cmd.jump)s.velocity[0]=NaN;
      return {state:s,detail:{injected:!fixed&&cfg.demoInjection,fault:cfg.fault}};
    },
    inspect:(s,v,c)=>{const w=v as SandboxWorld,r=(c as SandboxConfig).parameters.radius;return {numericFields:paths.map((path,i)=>({path,value:[...s.position,...s.velocity,s.yaw,s.pitch,s.height][i]!})),position:s.position,actorBounds:{min:[s.position[0]-r,s.position[1],s.position[2]-r],max:[s.position[0]+r,s.position[1]+s.height,s.position[2]+r]},worldBounds:w.bounds,colliders:w.colliders};}
  };
}
export const sandboxAdapter=createSandboxAdapter();
export const sandboxFixedAdapter=createSandboxAdapter(true);
export const sandboxStrategy:CommandStrategy<SandboxState>={
  nextCommand:ctx=>{const t=ctx.tick%240,phase=t<24?0:t<72?1:t<96?2:t<120?3:t<180?4:5;
    const explore=phase===5,draw=explore&&t%24===0?ctx.rng.nextFloat():.5;
    return {dx:phase===0?0:explore?(draw<.5?-1:1):1,dz:phase===4?(Math.floor(ctx.tick/240)%2?1:-1):0,jump:phase===2,crouch:phase===3,sprint:phase>=1&&phase<=3,yaw:0,pitch:0};},
  coverageKey:i=>i.position?Math.floor((i.position[0]+8)/2)+','+Math.floor((i.position[2]+6)/2):undefined,
  neutralCommand:()=>({dx:0,dz:0,jump:false,crouch:false,sprint:false,yaw:0,pitch:0})
};
export function createSandboxScenario(options:{seed:string;map?:string;scenario?:string}){
  const fault=options.scenario??options.map??'healthy';if(!['healthy','drop','penetration','non-finite'].includes(fault))throw new TypeError('Unknown sandbox scenario: '+fault);
  const rng=createRandomSource('sandbox-start:'+options.seed),floorEnd=fault==='drop'?1.5:8;
  const colliders:Collider[]=[
    {id:'floor',solid:true,bounds:{min:[-8,-1,-6],max:[floorEnd,0,6]}},
    {id:'target-wall',solid:true,bounds:{min:[3,0,-2],max:[3.7,3,2]}},
    {id:'outer-east',solid:true,bounds:{min:[7.5,-3,-6],max:[8,4,6]}},
    {id:'outer-west',solid:true,bounds:{min:[-8,-3,-6],max:[-7.5,4,6]}},
    {id:'outer-north',solid:true,bounds:{min:[-8,-3,5.5],max:[8,4,6]}},
    {id:'outer-south',solid:true,bounds:{min:[-8,-3,-6],max:[8,4,-5.5]}}
  ];
  const world:SandboxWorld={mapId:'sandbox-'+fault,bounds:{min:[-8,-3,-6],max:[8,8,6]},colliders,floorEnd,demoInjection:fault==='healthy'?'none':'PRESET DEFECT: '+fault};
  const config:SandboxConfig={fault:fault as SandboxConfig['fault'],demoInjection:fault!=='healthy',parameters:{...parameters},oracle:{...oracle,enabledAxes:[...oracle.enabledAxes],tolerance:[...oracle.tolerance]}};
  return {world,config,start:{position:[-1+rng.nextFloat()*.2,0,(rng.nextFloat()-.5)*1.2]},strategy:sandboxStrategy,maxTicks:3600};
}
export const sandboxTarget={id:'sandbox',adapter:sandboxAdapter,createScenario:createSandboxScenario};
export const sandboxFixedTarget={id:'sandbox-fixed',adapter:sandboxFixedAdapter,createScenario:createSandboxScenario};
export const registry={defaultTarget:'sandbox',targets:{sandbox:sandboxTarget,'sandbox-fixed':sandboxFixedTarget}};
