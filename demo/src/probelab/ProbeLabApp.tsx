import '@probelab/viewer/style.css';
import { ProbeLabLayout } from './ProbeLabLayout.js';
import { useProbeLabModel } from './useProbeLabModel.js';
import { useState } from 'react';
import { MapAuditPanel } from './MapAuditPanel.js';

export function ProbeLabApp() {
  const [audit,setAudit]=useState(new URLSearchParams(location.search).get('mode')==='audit');
  return <><nav className="probe-modebar"><button aria-pressed={!audit} onClick={()=>setAudit(false)}>探索与重放</button><button data-testid="open-map-audit" aria-pressed={audit} onClick={()=>setAudit(true)}>地图体检</button></nav>{audit?<MapAuditPanel/>:<Exploration/>}</>;
}
function Exploration(){
  const model = useProbeLabModel();
  return <ProbeLabLayout {...model} />;
}
