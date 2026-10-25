import test from 'node:test';
import assert from 'node:assert/strict';
import {sandboxTarget,sandboxFixedAdapter} from '../dist/index.js';
import {runCase,createProbePackage,importProbePackage,replayPackage,minimizeFailureAsync,canonicalHash} from '@probelab/core';
function sample(scenario){const s=sandboxTarget.createScenario({seed:'fixture-23',scenario}),request={...s,caseId:'sandbox-0',seed:'fixture-23',maxTicks:360};return {s,request,result:runCase(sandboxTarget.adapter,request,s.strategy)};}
test('independent healthy world: floor contact, wall blocking, jumps and crouching are not faults',()=>{const {result}=sample('healthy');assert.equal(result.status,'complete');assert.equal(result.failure,undefined);});
for(const [scenario,kind] of [['drop','out-of-bounds'],['penetration','penetration'],['non-finite','non-finite-state']])test('explicit preset defect actually returns '+kind,()=>{
  const {request,result}=sample(scenario);assert.equal(result.failure.kind,kind);assert.ok(result.failure.tick>1);
  const p=createProbePackage(sandboxTarget.adapter,request,result),parsed=importProbePackage(JSON.stringify(p));assert.equal(parsed.ok,true);
  assert.equal(replayPackage(sandboxTarget.adapter,parsed.value,{mode:'strict'}).status,'verified-failure');
  if(scenario==='non-finite'){assert.ok(JSON.stringify(p).includes('"$probeNumber":"NaN"'));assert.equal(result.failure.detail.path,'/velocity/0');}
});
test('deletion really removes redundant prefix and preserves first signature in two independent reruns',async()=>{
  const {s,request,result}=sample('non-finite'),p=createProbePackage(sandboxTarget.adapter,request,result);
  const m=await minimizeFailureAsync(sandboxTarget.adapter,p,s.strategy,{maxRuns:200,maxTicks:20000,maxMilliseconds:10000,clock:()=>Date.now()},{yield:()=>new Promise(r=>setImmediate(r))});
  assert.ok(m.reducedLength<m.originalLength);assert.ok(m.replayVerifications>=2);assert.ok(m.package);
  assert.equal(canonicalHash(m.package.outcome.failure.signature),canonicalHash(p.outcome.failure.signature));
  for(let i=0;i<2;i++)assert.equal(replayPackage(sandboxTarget.adapter,m.package,{mode:'strict'}).status,'verified-failure');
  assert.equal(replayPackage(sandboxFixedAdapter,m.package,{mode:'regress'}).status,'healthy');
  assert.equal(replayPackage(sandboxFixedAdapter,m.package,{mode:'strict'}).status,'incompatible');
});
test('world repair for missing floor requires an explicit target world/config',()=>{
  const {request,result}=sample('drop'),p=createProbePackage(sandboxTarget.adapter,request,result),target=sandboxTarget.createScenario({seed:'fixture-23',scenario:'healthy'});
  assert.notEqual(replayPackage(sandboxFixedAdapter,p,{mode:'regress'}).status,'healthy');
  const fixed=replayPackage(sandboxFixedAdapter,p,{mode:'regress',targetWorld:target.world,targetConfig:target.config});
  assert.equal(fixed.status,'healthy');assert.ok(fixed.targetDifferences.some(s=>s.includes('world hash')));
});
