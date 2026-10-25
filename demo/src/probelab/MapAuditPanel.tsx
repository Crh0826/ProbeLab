import { useEffect, useRef, useState } from 'react';
import { canonicalHash } from '@probelab/core';
import type { AuditIssue, AuditReport } from '@probelab/audit';
import { importAuditReport } from '@probelab/audit';
import { createDemoAudit } from './demoAudit.js';
import { createProbeViewer } from '@probelab/viewer';
import type { ProbeViewer } from '@probelab/viewer';
import './audit.css';

export function MapAuditPanel(){
  const [mapId,setMapId]=useState('demo-a'),[report,setReport]=useState<AuditReport>(),[issue,setIssue]=useState<AuditIssue>(),[message,setMessage]=useState('选择地图，运行定向体检。'),[running,setRunning]=useState(false);
  const worker=useRef<Worker | undefined>(undefined),host=useRef<HTMLDivElement>(null),viewer=useRef<ProbeViewer | undefined>(undefined);
  useEffect(()=>{if(host.current)viewer.current=createProbeViewer(host.current);const close=()=>{worker.current?.terminate();viewer.current?.dispose();};window.addEventListener('pagehide',close);return()=>{window.removeEventListener('pagehide',close);close();};},[]);
  useEffect(()=>{
    const {map}=createDemoAudit(mapId),evidence=report?.evidence.find(e=>e.route.id===issue?.routeId),attempt=evidence?.attempts.at(-1);
    viewer.current?.setData({scene:{mapId,coordinateSystem:'Y-up',units:'metres',colliders:(report?.debugMap?.surfaces??map.surfaces).filter(s=>s.bounds.min.every((n,i)=>n<s.bounds.max[i]!)).map(s=>({id:s.id,bounds:s.bounds,solid:s.solid})),labels:report?.issues.map(i=>({id:i.id,label:i.rule,position:i.position}))??[]},tracks:attempt?[{id:evidence!.route.id,trace:attempt.frames.map(f=>({tick:f.tick,position:f.position,command:f.command,state:f.state}))}]:[]});
    viewer.current?.setTick(attempt?.frames.at(-1)?.tick??0);if(issue)viewer.current?.focusAt(issue.position,9);
  },[mapId,report,issue]);
  const run=()=>{worker.current?.terminate();setRunning(true);setReport(undefined);setIssue(undefined);setMessage('正在运行真实移动模拟…');const w=new Worker(new URL('./audit.worker.ts',import.meta.url),{type:'module'});worker.current=w;
    w.onmessage=event=>{const d=event.data;if(d.type==='progress')setMessage(`定向路径 ${d.done}/${d.total}`);else {w.terminate();setRunning(false);if(d.type==='report'){setReport(d.report);setMessage(`已检查 ${d.report.checked.routes} 条路径、${d.report.checked.ticks} tick。${d.report.incomplete?'预算未覆盖全部路径，请继续分批检查。':''}`);}else setMessage(d.message);}};
    w.onerror=e=>{w.terminate();setRunning(false);setMessage(e.message);};w.postMessage({mapId,maxRoutes:48});};
  const download=(markdown=false)=>{if(!report)return;const body=markdown?`# ${report.mapId} 地图体检\n\n${report.issues.map(i=>`- [${i.severity}] ${i.rule}: ${i.title}; xyz=${i.position.join(',')}; id=${i.id}`).join('\n')}\n\n复现输入及状态请使用配套JSON。`:JSON.stringify(report);const url=URL.createObjectURL(new Blob([body],{type:markdown?'text/markdown':'application/json'}));const a=document.createElement('a');a.href=url;a.download=report.mapId+'.audit.'+(markdown?'md':'json');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const verify=()=>{if(!report||!issue?.routeId)return;const {map,driver}=createDemoAudit(mapId);if(map.sourceHash!==report.sourceHash){setMessage('源地图已变化，拒绝当作同版本重放。');return;}const e=report.evidence.find(e=>e.route.id===issue.routeId);if(!e)return;const original=e.attempts.at(-1)!;const replay=driver.run(e.route,e.route.kind==='jump-landing'||e.attempts.length>1,report.limits.maxTicksPerAttempt,()=>false);setMessage(canonicalHash(replay)===canonicalHash(original)?'严格重放通过：命令、逐tick状态和结果完全一致。':'重放发生分歧，请保留报告核查。');};
  return <div className="map-audit" data-testid="map-audit-panel">
    <header><h1>地图体检 · 独立示例</h1><p>出生点 → 区域通路 · 楼梯斜坡 · 跳跃落点 · 卡住现场 · 表面/碰撞/射击遮挡</p><a href="/">返回演示首页</a></header>
    <div className="audit-controls"><select aria-label="体检地图" data-testid="audit-map" disabled={running} value={mapId} onChange={e=>{setMapId(e.target.value);setReport(undefined);setIssue(undefined);}}><option value="demo-a">Demo A · 出生点与阻断路线</option><option value="demo-b">Demo B · 表面不一致</option><option value="demo-c">Demo C · 独立小场景</option></select><button data-testid="audit-run" disabled={running} onClick={run}>运行地图体检</button><button disabled={!running} onClick={()=>{worker.current?.terminate();setRunning(false);setMessage('已停止；本轮未完成，不输出通过结论。');}}>停止</button><button disabled={!report} onClick={()=>download()}>导出完整 JSON</button><button disabled={!report} onClick={()=>download(true)}>导出问题 Markdown</button><label>导入报告 <input data-testid="audit-import" type="file" accept=".json" onChange={async e=>{try{const file=e.target.files?.[0];if(!file)return;if(file.size>32*1024*1024)throw new Error('报告超过32MiB');const parsed=importAuditReport(await file.text());if(!['demo-a','demo-b','demo-c'].includes(parsed.mapId))throw new Error('格式、地图或内容hash错误');setMapId(parsed.mapId);setReport(parsed);setIssue(undefined);setMessage(parsed.debugMap?'仅查看导入数据；报告自带几何快照。同版本源地图才可严格重放。':'仅查看导入数据；旧报告没有几何快照，当前地图仅供参考。');}catch(error){setMessage('导入失败：'+String(error));}}}/></label></div>
    <p role="status" data-testid="audit-status">{message}</p>
    <div className="audit-summary" data-testid="audit-summary">{report?`确定错误 ${report.issues.filter(i=>i.severity==='error').length} · 待复核 ${report.issues.filter(i=>i.severity==='review').length} · ${report.checked.surfaces} 个源几何 · ${report.checked.spawns} 个出生点 · ${report.checked.rays} 条射线`:'检查结果将保留坐标、源几何ID、路径、实际命令及逐tick状态。'}</div>
    <div className="audit-columns"><section><h2>问题与定位</h2><div className="audit-issues">{report?.issues.map(i=><button data-testid="audit-issue" className={issue?.id===i.id?'selected':''} key={i.id} onClick={()=>setIssue(i)}><b>{i.severity==='error'?'确定错误':'待复核'} · {i.rule}</b><span>{i.title}</span><small>{i.position.map(n=>n.toFixed(2)).join(', ')}</small></button>)}{report?.issues.length===0?<p>本次检查未报告问题，不代表地图无Bug。</p>:null}</div></section><section><div className="audit-viewer" ref={host}/><p>鼠标拖拽查看现场；轨迹为实际模拟记录。</p><button data-testid="audit-replay" disabled={!issue?.routeId} onClick={verify}>验证该路径重放</button>{issue?<pre>{JSON.stringify(issue,null,2)}</pre>:<p>点击问题，定位几何或失败路径。灰盒视图用于碰撞定位；复杂形状及视觉效果请结合地图巡检视频复核。</p>}</section></div>
    <footer>待复核候选不会自动被当作确定Bug。装饰性可穿透面可能是合理设计；路线控制器失败不证明所有走法都不通。</footer>
  </div>;
}
