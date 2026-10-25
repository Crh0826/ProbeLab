import type { CSSProperties, ReactElement } from 'react';
import { targets } from './targets.js';
import { MAX_PROBE_TICKS, type ProbeScenarioId } from './types.js';
import { FAILURE_LABEL, MAPS, SCENARIOS } from './probeLabUtils.js';
import type { useProbeLabModel } from './useProbeLabModel.js';

type ProbeLabModel = ReturnType<typeof useProbeLabModel>;

export function ProbeLabLayout(model: ProbeLabModel): ReactElement {
  const {
    viewerHostRef, labState, targetId, setTargetId, scenario, setScenario, configurationLocked, mapId, setMapId,
    rootSeed, setRootSeed, probeCount, setProbeCount, visibleProbeCount, setVisibleProbeCount,
    simulationConcurrency, setSimulationConcurrency, maxTicks, setMaxTicks, startRun, pauseRun, resumeRun, stopRun,
    caseProgress, completedCount, totalTicks, plannedTicks, coverage, issueRows, sortedCases, debugWorld,
    geometryWarnings, demoLabel, showGrid, setShowGrid, showColliders, setShowColliders, showActorAabbs,
    setShowActorAabbs, showPaths, setShowPaths, showActors, setShowActors, packageToShow, selectedCaseId,
    jumpToCase, chooseIssue, selectedFrame, displayedFailure, validation, isMinimizing, isCancellingMinimize,
    canMinimize, canUsePackage, runValidation, minimize, minimizeLabel, fileInputRef, importFile, exportPackage, hasPackage,
    displayVersion, setDisplayVersion, activePackage, reducedPackage, reducedFullyVerified, selectedStored,
    currentCommand, rawState, jumpFailure, moveTick, playing, setPlaying, currentTick, setCurrentTick,
    selectedTraceMax, speed, setSpeed, message, setMessage,
  } = model;

  return (
    <div className="probe-app" data-testid="probe-lab-root">
      <header className="probe-topbar">
        <div className="probe-brand"><span className="probe-brand__mark">P</span><div><strong>ProbeLab</strong><small>AUTOMATION WORKBENCH</small></div></div>
        <div className="probe-topbar__title"><span className="probe-eyebrow">ProbeLab / DEVELOPER TOOLS</span><h1>自动测试实验室</h1></div>
        <div className="probe-topbar__right">
          <span className={`probe-status probe-status--${labState}`}><i />{labState === 'running' ? '探针运行中' : labState === 'paused' ? '运行已暂停' : labState === 'complete' ? '本轮完成' : labState === 'stopped' ? '已停止' : labState === 'error' ? '运行错误' : 'READY'}</span>
          <a className="probe-back-link" href="/">返回 ProbeLab</a>
        </div>
      </header>

      <div className="probe-layout">
        <aside className="probe-sidebar">
          <div className="probe-panel-title"><span className="probe-kicker">01 / RUN</span><h2>探索配置</h2></div>
          <label className="probe-field"><span>测试目标</span><select data-testid="target-select" value={targetId} onChange={(event) => { setTargetId(event.target.value); setScenario('healthy'); }} disabled={configurationLocked}>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.id === 'fps' ? 'ProbeLab · 当前 FPS' : target.id === 'sandbox-fixed' ? 'Sandbox · 修复版回归适配器' : 'Sandbox · 独立适配示例'}</option>)}
          </select></label>
          {targetId === 'fps' ? <label className="probe-field"><span>地图</span><select data-testid="map-select" value={mapId} onChange={(event) => setMapId(event.target.value)} disabled={configurationLocked}>{MAPS.map((map) => <option key={map.id} value={map.id}>{map.label}</option>)}</select></label> : <label className="probe-field"><span>场景</span><select data-testid="scenario-select" value={scenario} onChange={(event) => setScenario(event.target.value as ProbeScenarioId)} disabled={configurationLocked}>{SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
          <label className="probe-field"><span>固定随机种子</span><input data-testid="seed-input" value={rootSeed} maxLength={64} onChange={(event) => setRootSeed(event.target.value)} disabled={configurationLocked} /></label>
          <label className="probe-field"><span>探针数量 <b>{probeCount}</b></span><input data-testid="probe-count" type="range" min="1" max="16" value={probeCount} onChange={(event) => { const value = Number(event.target.value); setProbeCount(value); setVisibleProbeCount((current) => Math.min(current, value)); }} disabled={configurationLocked} /></label>
          <label className="probe-field"><span>模拟并发 <b>{simulationConcurrency}</b></span><input data-testid="simulation-concurrency" type="range" min="1" max={probeCount} value={Math.min(simulationConcurrency, probeCount)} onChange={(event) => setSimulationConcurrency(Number(event.target.value))} disabled={configurationLocked} /><small>Worker 池中同时推进的探针数</small></label>
          <label className="probe-field"><span>可视化探针 <b>{visibleProbeCount}</b></span><input data-testid="visible-count" type="range" min="1" max={probeCount} value={Math.min(visibleProbeCount, probeCount)} onChange={(event) => setVisibleProbeCount(Number(event.target.value))} /></label>
          <label className="probe-field"><span>每探针 tick 预算</span><input data-testid="max-ticks" type="number" min="1" max={MAX_PROBE_TICKS} step="1" value={maxTicks} onChange={(event) => { const value = Number(event.target.value) || 1; setMaxTicks(Math.max(1, Math.min(MAX_PROBE_TICKS, Math.floor(value)))); }} disabled={configurationLocked} /><small>上限 {MAX_PROBE_TICKS.toLocaleString()} tick；与故障包导出限制一致</small></label>
          <div className="probe-run-actions">
            {labState === 'running' ? <button className="probe-button probe-button--secondary" data-testid="pause-run" onClick={pauseRun}>Ⅱ 暂停</button> : labState === 'paused' ? <button className="probe-button probe-button--primary" data-testid="resume-run" onClick={resumeRun}>▶ 继续</button> : labState === 'stopping' ? <button className="probe-button probe-button--secondary" data-testid="starting-run" disabled>停止中…</button> : <button className="probe-button probe-button--primary" data-testid="start-run" onClick={startRun}>▶ 开始探索</button>}
            {labState === 'running' || labState === 'paused' || labState === 'stopping' ? <button className="probe-icon-button probe-icon-button--danger" data-testid="stop-run" onClick={stopRun} disabled={labState === 'stopping'} aria-label="停止探针">■</button> : <span className="probe-budget-note">{(probeCount * maxTicks).toLocaleString()} 最大 tick</span>}
          </div>

          <div className="probe-divider" />
          <div className="probe-section-heading"><div><span className="probe-kicker">02 / SIGNAL</span><h2>探索进度</h2></div><strong>{Math.round(caseProgress)}%</strong></div>
          <div className="probe-progress-track"><div className="probe-progress-fill" style={{ width: `${caseProgress}%` }} /></div>
          <div className="probe-stat-line"><span>已完成探针</span><b>{completedCount} <small>/ {probeCount}</small></b></div>
          <div className="probe-stat-line"><span>实际执行 tick</span><b>{totalTicks.toLocaleString()} <small>/ {plannedTicks.toLocaleString()}</small></b></div>
          <div className="probe-stat-line"><span>空间覆盖</span><b>{coverage === undefined ? '等待边界' : `${coverage.visited}/${coverage.total} 格`}</b></div>
          {coverage !== undefined ? <div className="probe-coverage-caption">按地图 XZ 平面 8×8 网格统计实际采样位置</div> : null}
          <div className="probe-stat-line"><span>确定故障</span><b className={issueRows.length > 0 ? 'probe-danger-text' : ''}>{issueRows.length}</b></div>
          <div className="probe-sidebar__foot"><span className="probe-live-dot" />真实运行数据 · 不显示预写轨迹</div>
        </aside>

        <main className="probe-main">
          <div className="probe-scene-head">
            <div><span className="probe-kicker">LIVE SCENE / {debugWorld?.mapId ?? mapId.toUpperCase()}</span><h2>{debugWorld?.mapId ?? (targetId === 'fps' ? mapId : targetId)} <small>{debugWorld?.coordinateSystem ?? '等待地图坐标'}</small>{targetId === 'sandbox-fixed' || packageToShow?.descriptor.adapterId.includes('fixed') === true ? <em className="probe-demo-chip">REGRESSION TARGET</em> : demoLabel ? <em className="probe-demo-chip">PRESET DEMO · {demoLabel}</em> : null}{geometryWarnings.length > 0 ? <em className="probe-geometry-chip" data-testid="geometry-warning-count">⚠ GEOMETRY · {geometryWarnings.length}</em> : null}</h2></div>
            <div className="probe-scene-tools">
              <label className="probe-compact-select"><span>显示探针</span><select data-testid="visual-count-select" value={visibleProbeCount} onChange={(event) => setVisibleProbeCount(Number(event.target.value))}>{Array.from({ length: 16 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
              <button className={`probe-tool-toggle ${showGrid ? 'is-on' : ''}`} data-testid="toggle-grid" onClick={() => setShowGrid((value) => !value)} title="网格">GRID</button>
              <button className={`probe-tool-toggle ${showColliders ? 'is-on' : ''}`} data-testid="toggle-colliders" onClick={() => setShowColliders((value) => !value)} title="碰撞体">HITBOX</button>
              <button className={`probe-tool-toggle ${showActorAabbs ? 'is-on' : ''}`} data-testid="toggle-aabb" onClick={() => setShowActorAabbs((value) => !value)} title="真实采集的角色 AABB">AABB</button>
              <button className={`probe-tool-toggle ${showPaths ? 'is-on' : ''}`} data-testid="toggle-paths" onClick={() => setShowPaths((value) => !value)} title="轨迹">PATH</button>
              <button className={`probe-tool-toggle ${showActors ? 'is-on' : ''}`} data-testid="toggle-actors" onClick={() => setShowActors((value) => !value)} title="探针幽灵">GHOST</button>
            </div>
          </div>
          <section className="probe-viewer-panel" aria-label="3D 场景与探针轨迹">
            <div className="probe-viewer-host" ref={viewerHostRef} data-testid="probe-viewer" />
            {sortedCases.length === 0 && packageToShow === undefined ? <div className="probe-empty-state"><div className="probe-empty-crosshair">＋</div><strong>等待探针进入场景</strong><span>开始探索后，这里会显示真实运行的轨迹与幽灵</span><span className="probe-empty-hint">拖拽绕场观察 · 滚轮缩放 · 点击幽灵选择探针</span></div> : null}
            <div className="probe-scene-legend"><span><i className="legend-probe" />探针</span><span><i className="legend-path" />实际轨迹</span><span><i className="legend-fault" />首故障位置</span>{geometryWarnings.length > 0 ? <span><i className="legend-world-warning" />地图提示</span> : null}</div>
            <div className="probe-orbit-hint">ORBIT · DRAG &nbsp; ZOOM · SCROLL</div>
          </section>
          <section className="probe-case-strip">
            <div className="probe-case-strip__head"><div><span className="probe-kicker">PROBES / {sortedCases.length.toString().padStart(2, '0')}</span><strong>运行中的独立探针</strong></div><span>最大显示 {visibleProbeCount} 条</span></div>
            <div className="probe-case-list">
              {sortedCases.length === 0 ? <div className="probe-case-empty">尚无探针记录 · 配置后点击“开始探索”</div> : sortedCases.map(([caseId, stored], index) => {
                const failure = stored.result.failure ?? stored.result.invalidStart;
                const selected = selectedCaseId === caseId;
                return <button key={caseId} data-testid={`case-${caseId}`} className={`probe-case-card ${selected ? 'is-selected' : ''} ${failure ? 'has-failure' : ''}`} onClick={() => jumpToCase(caseId)}>
                  <span className="probe-case-color" style={{ '--case-color': ['#69d4bd', '#70a9ff', '#f0b35c', '#d89aff', '#ff7e73', '#95d66f', '#72d5e8', '#ff9ec0'][index % 8] } as CSSProperties} />
                  <span className="probe-case-card__body"><b>{caseId}</b><small>{failure ? FAILURE_LABEL[failure.kind] : `${stored.result.ticksExecuted.toLocaleString()} ticks`}</small></span>
                  <span className={`probe-mini-status probe-mini-status--${failure ? 'fault' : stored.result.status}`}>{failure ? 'FAULT' : stored.result.status === 'complete' ? 'DONE' : stored.result.status === 'paused' ? 'PAUSED' : stored.result.status === 'cancelled' ? 'STOP' : 'RUN'}</span>
                </button>;
              })}
            </div>
          </section>
        </main>

        <aside className="probe-inspector">
          <div className="probe-inspector__top"><div><span className="probe-kicker">03 / INSPECT</span><h2>故障与状态</h2></div><span className="probe-fault-count">{issueRows.length.toString().padStart(2, '0')}</span></div>
          <div className="probe-issue-list" data-testid="issue-list">
            {issueRows.length === 0 ? <div className="probe-no-issues"><span>⌁</span><b>尚未发现确定故障</b><small>只有模拟实际触发 oracle 或导入故障记录后才会列入</small></div> : issueRows.map((issue) => {
              const { caseId, failure } = issue;
              return <button key={caseId} className={`probe-issue ${selectedCaseId === caseId ? 'is-selected' : ''}`} data-testid={`issue-${caseId}`} onClick={() => chooseIssue(issue)}>
                <span className={`probe-issue__icon probe-issue__icon--${failure.kind}`}>{failure.kind === 'out-of-bounds' ? '↗' : failure.kind === 'penetration' ? '◇' : failure.kind === 'non-finite-state' ? '∞' : '!'}</span>
                <span className="probe-issue__copy"><b>{FAILURE_LABEL[failure.kind]}</b><small>{issue.source === 'imported' ? '导入记录' : '本轮运行'} · {caseId} · tick {failure.tick}</small><small className="probe-mono">{failure.signature.target}</small></span><span className="probe-issue__arrow">↗</span>
              </button>;
            })}
          </div>

          <div className="probe-inspector-divider" />
          <div className="probe-inspector__top probe-inspector__top--small"><div><span className="probe-kicker">TRACE / EVIDENCE</span><h2>{selectedCaseId ?? packageToShow?.case.caseId ?? '未选择记录'}</h2></div>{selectedFrame ? <span className="probe-tick-badge">T{selectedFrame.tick}</span> : null}</div>
          <div className="probe-state-scroll">
            {displayedFailure !== undefined ? <div className="probe-evidence-card"><span className="probe-evidence-label">FIRST FAILURE</span><strong>{FAILURE_LABEL[displayedFailure.kind]}</strong><span>tick {displayedFailure.tick} · {displayedFailure.signature.target}</span></div> : null}
            <div className="probe-state-heading">当前命令 <small>规范 tick 输入</small></div>
            <pre className="probe-code-block" data-testid="current-command">{currentCommand === undefined ? '选择一个探针或导入故障包' : JSON.stringify(currentCommand, null, 2)}</pre>
            <div className="probe-state-heading">当前状态 <small>{selectedFrame?.stateHash ?? '完整 DTO'}</small></div>
            <pre className="probe-code-block probe-code-block--state" data-testid="current-state">{rawState === undefined ? '等待模拟数据' : JSON.stringify(rawState, null, 2)}</pre>
            {geometryWarnings.length > 0 ? <div className="probe-world-warnings" data-testid="world-geometry-warnings"><div className="probe-world-warnings__head"><b>地图几何提示 · {geometryWarnings.length}</b><small>世界数据检查 · 不计入探针故障</small></div>{geometryWarnings.map((warning, index) => <div className="probe-world-warnings__item" key={`${warning}-${index}`}><span>⚠</span>{warning}</div>)}</div> : null}
            <div className="probe-validation-card" data-testid="validation-status">
              <div className="probe-validation-card__head"><span className={`probe-validation-dot probe-validation-dot--${validation.state}`} /><b>{validation.state === 'verified' ? '严格重放已验证' : validation.state === 'compatible' ? '兼容但尚未重放' : validation.state === 'incompatible' ? 'Adapter 不兼容' : validation.state === 'diverged' ? '重放发生分歧' : validation.state === 'checking' ? '正在验证' : validation.state === 'healthy' ? '健康重放' : validation.state === 'error' ? '验证错误' : '仅查看记录'}</b></div>
              <p>{validation.message}</p>
              {validation.firstDivergentTick !== undefined ? <div className="probe-divergence">首个分歧：tick {validation.firstDivergentTick}</div> : null}
              {validation.differences.map((difference, index) => <div className="probe-compat-diff" key={`${difference}-${index}`}>· {difference}</div>)}
            </div>
            <div className="probe-package-actions">
              <button className="probe-button probe-button--secondary" data-testid="validate-package" onClick={runValidation} disabled={!canUsePackage || validation.state === 'checking' || isMinimizing}>✓ 验证重放</button>
              <button className="probe-button probe-button--secondary" data-testid="minimize-package" onClick={minimize} disabled={!canMinimize && !isMinimizing}>{isMinimizing ? isCancellingMinimize ? '正在取消…' : '■ 取消缩减' : '⌁ 缩减复现'}</button>
            </div>
            {minimizeLabel ? <div className="probe-minimize-result" data-testid="minimize-result">{minimizeLabel}</div> : null}
            <div className="probe-package-actions probe-package-actions--files">
              <button className="probe-button probe-button--subtle" data-testid="import-package" onClick={() => fileInputRef.current?.click()} disabled={isMinimizing}>↑ 导入故障包</button>
              <button className="probe-button probe-button--subtle" data-testid="export-package" onClick={exportPackage} disabled={!canUsePackage && selectedStored?.pkg === undefined}>↓ 导出</button>
              <input ref={fileInputRef} data-testid="package-file" type="file" accept=".json,.probe.json,application/json" hidden onChange={importFile} />
            </div>
            {hasPackage ? <div className="probe-version-switch" data-testid="package-version-switch"><span>查看记录</span><button className={displayVersion === 'original' ? 'is-active' : ''} data-testid="show-original" onClick={() => { setDisplayVersion('original'); setCurrentTick(0); }}>原始 {activePackage?.outcome.ticksExecuted ?? packageToShow?.outcome.ticksExecuted ?? ''}</button><button className={displayVersion === 'reduced' ? 'is-active' : ''} data-testid="show-reduced" disabled={reducedPackage === undefined} onClick={() => { setDisplayVersion('reduced'); setCurrentTick(0); }}>{reducedFullyVerified ? '缩减✓' : '候选'} {reducedPackage?.outcome.ticksExecuted ?? '—'}</button></div> : null}
          </div>
        </aside>
      </div>

      <footer className="probe-timeline">
        <div className="probe-timeline__transport">
          <button className="probe-transport-button" data-testid="jump-failure" onClick={jumpFailure} disabled={displayedFailure === undefined} title="跳到故障前">↯</button>
          <button className="probe-transport-button" data-testid="step-back" onClick={() => moveTick(-1)} disabled={selectedTraceMax === 0}>−1</button>
          <button className="probe-play-button" data-testid="play-pause" onClick={() => setPlaying((value) => !value)} disabled={selectedTraceMax === 0}>{playing ? 'Ⅱ' : '▶'}</button>
          <button className="probe-transport-button" data-testid="step-forward" onClick={() => moveTick(1)} disabled={selectedTraceMax === 0}>+1</button>
          <select className="probe-speed-select" data-testid="playback-speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={0.25}>0.25×</option><option value={1}>1×</option><option value={2}>2×</option></select>
        </div>
        <div className="probe-timeline__scrub">
          <div className="probe-timeline__labels"><span>{packageToShow?.case.caseId ?? selectedCaseId ?? 'NO TRACE'}</span><span>{currentTick.toLocaleString()} <small>/ {selectedTraceMax.toLocaleString()} tick</small></span></div>
          <input data-testid="timeline" type="range" min="0" max={Math.max(1, selectedTraceMax)} value={Math.min(currentTick, Math.max(1, selectedTraceMax))} onChange={(event) => { setPlaying(false); setCurrentTick(Number(event.target.value)); }} disabled={selectedTraceMax === 0} />
          <div className="probe-timeline__ticks"><span>T0</span><span>{Math.floor(selectedTraceMax * 0.25).toLocaleString()}</span><span>{Math.floor(selectedTraceMax * 0.5).toLocaleString()}</span><span>{Math.floor(selectedTraceMax * 0.75).toLocaleString()}</span><span>T{selectedTraceMax.toLocaleString()}</span></div>
        </div>
        <div className="probe-timeline__meta"><span className="probe-meta-label">SEED</span><b>{packageToShow?.case.seed ?? selectedStored?.result.seed ?? rootSeed}</b><span className="probe-timeline__divider" /><span>{debugWorld?.mapId ?? mapId}</span></div>
      </footer>
      {message ? <div className="probe-toast" role="status" data-testid="status-message"><span>{message}</span><button onClick={() => setMessage('')} aria-label="关闭消息">×</button></div> : null}
    </div>
  );
}
