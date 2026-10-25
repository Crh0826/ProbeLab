import {sandboxTarget,sandboxFixedTarget} from '@probelab/sandbox';
import type {ProbeTarget} from './types.js';
export const targets:readonly ProbeTarget[]=[{...sandboxTarget,id:'fps',name:'Independent sandbox'},{...sandboxTarget,name:'Sandbox'},{...sandboxFixedTarget,name:'Fixed sandbox'}];
export function getTarget(id:string){return targets.find(t=>t.id===id);}
