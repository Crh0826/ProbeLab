import {auditMap} from '@probelab/audit';
import {createDemoAudit} from './demoAudit.js';
self.onmessage=async(e:MessageEvent<{mapId:string;maxRoutes:number}>)=>{try{const {map,driver}=createDemoAudit(e.data.mapId);const report=await auditMap(map,driver,{maxRoutes:e.data.maxRoutes,yield:()=>new Promise(r=>setTimeout(r,0)),progress:(done,total)=>self.postMessage({type:'progress',done,total})});self.postMessage({type:'report',report});}catch(error){self.postMessage({type:'error',message:String(error)});}};
