"use client";
import { useEffect, useRef, useState } from "react";
import Graph from "../components/native-plan-graph";
import { exampleGroups, examples, optionLabels, stageLabels } from "../../lib/playground";
import type { Optimization, OptimizerOptions } from "../../lib/playground";

export default function Playground() {
  const [code, setCode] = useState(examples[0].code);
  const [example, setExample] = useState("0");
  const [target, setTarget] = useState("dag");
  const [physical, setPhysical] = useState(false);
  const [selector, setSelector] = useState<"default" | "greedy">("default");
  const [resolve, setResolve] = useState(true);
  const [options, setOptions] = useState<OptimizerOptions>(Object.fromEntries(Object.keys(optionLabels).map(key => [key, true])) as OptimizerOptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Optimization | null>(null);
  const [planIndex, setPlanIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const graphPanel = useRef<HTMLElement>(null);
  const plan = result?.plans[planIndex];
  const previous = result?.plans[planIndex - 1];
  const node = plan?.nodes.find(n => n.id === selected);
  const nodes = plan?.nodes.filter(n => `${n.id} ${n.label}`.toLowerCase().includes(query.toLowerCase())) ?? [];

  useEffect(() => {
    function syncFullscreen() { setFullscreen(document.fullscreenElement === graphPanel.current); }
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  async function toggleFullscreen() {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === graphPanel.current) await document.exitFullscreen();
      else await graphPanel.current?.requestFullscreen();
    } catch {
      setFullscreenError("Fullscreen is unavailable in this browser. You can still use the zoom controls.");
    }
  }

  async function optimize() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/optimizer", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, target, phase: physical ? "physical" : "logical", selector, options, resolve_variables: resolve }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Optimization request failed.");
      setResult(body); setPlanIndex(Math.max(0, body.plans.length - 1)); setSelected(null); setQuery("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not contact the optimizer.");
    } finally { setBusy(false); }
  }
  function selectPlan(index: number) { setPlanIndex(index); setSelected(null); }

  return <>
    <div className="heading"><div><p className="eyebrow">OPTIMIZER WORKBENCH</p><h1>Optimizer playground</h1><p>Build a skrub DAG and explore how Stratum rewrites it, stage by stage.</p></div></div>
    <div className="playground-grid">
      <section className="panel editor-panel">
        <div className="panel-heading"><h2>Python input</h2><select aria-label="Load example" value={example} disabled={busy} onChange={event => { const item = examples[Number(event.target.value)]; setExample(event.target.value); setCode(item.code); setTarget("dag"); setPhysical(item.phase === "physical"); setSelector(item.selector ?? "default"); }}>{exampleGroups.map(group => <optgroup label={group} key={group}>{examples.map((item, index) => item.group === group && <option value={index} key={item.name}>{item.name}</option>)}</optgroup>)}</select></div>
        <div className="editor-help">Define your output as <code>{target || "dag"}</code>. Eager previews are disabled while building the DAG.</div>
        <textarea aria-label="Skrub Python code" spellCheck={false} value={code} onChange={event => setCode(event.target.value)}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !busy) { event.preventDefault(); void optimize(); } }} />
        <div className="editor-options">
          <label className="target-field">Output variable <input value={target} aria-label="Output variable" onChange={event => setTarget(event.target.value)} /></label>
          <details><summary>Optimizer passes</summary><div className="pass-options">{Object.entries(optionLabels).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key as keyof OptimizerOptions]} onChange={event => setOptions({ ...options, [key]: event.target.checked })} />{label}</label>)}</div></details>
          <label><input type="checkbox" checked={resolve} onChange={event => setResolve(event.target.checked)} />Resolve variable values</label>
          <label><input type="checkbox" checked={physical} onChange={event => setPhysical(event.target.checked)} />Include physical planning</label>
          {physical && <label>Implementation selector <select aria-label="Implementation selector" value={selector} onChange={event => setSelector(event.target.value as "default" | "greedy")}><option value="default">Default (pandas)</option><option value="greedy">Greedy (pandas &amp; polars)</option></select></label>}
          <button className="primary" disabled={busy || !code.trim() || !target.trim()} onClick={() => void optimize()}>{busy ? "Optimizing…" : "Optimize DAG"}</button>
          <p className="editor-footnote">Ctrl / ⌘ + Enter to optimize. Python runs locally with your user’s permissions.</p>
        </div>
      </section>
      <div className="playground-output" aria-busy={busy}>
        {error && <div className="alert" role="alert">{error}</div>}
        {result?.error && <div className="alert" role="alert"><strong>{result.error.stage}: {result.error.type}</strong><p>{result.error.message}</p><details><summary>Python traceback</summary><pre>{result.error.traceback}</pre></details></div>}
        {!result && !error && <section className="empty"><h2>Your plan starts here</h2><p>Choose an example or write a pipeline, then select Optimize DAG to inspect the input graph, conversion and rewrite stages.</p></section>}
        {result && <>
          <div className="playground-summary" aria-live="polite"><span className={`badge ${result.status}`}>{result.status}</span><span>{result.plans.length} stages · {result.timings.optimization.toFixed(4)} s optimizing · {result.timings.total.toFixed(2)} s request</span>{busy && <span>Updating…</span>}</div>
          <section className="panel graph-panel" ref={graphPanel}>
            <div className="panel-heading"><div><h2>{plan ? stageLabels[plan.name] ?? plan.name : "Plan stages"}</h2><p>{plan?.nodes.length ?? 0} nodes{previous && ` · ${plan!.nodes.length - previous.nodes.length >= 0 ? "+" : ""}${plan!.nodes.length - previous.nodes.length} from previous stage`}</p></div>
              <div className="graph-controls" role="group" aria-label="Graph view controls">
                <button aria-label="Zoom out" title="Zoom out" disabled={!plan?.svg || zoom <= 0.1} onClick={() => setZoom(value => Math.max(0.1, Math.round(value / 1.25 * 100) / 100))}>−</button>
                <button className="zoom-level" aria-label="Reset zoom to 100%" title="Reset zoom to 100%" disabled={!plan?.svg} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                <button aria-label="Zoom in" title="Zoom in" disabled={!plan?.svg || zoom >= 4} onClick={() => setZoom(value => Math.min(4, Math.round(value * 1.25 * 100) / 100))}>+</button>
                <button aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
              </div>
            </div>
            {fullscreenError && <p role="alert">{fullscreenError}</p>}
            <nav className="stage-list" aria-label="Optimizer stages">{result.plans.map((item, index) => <button key={`${index}-${item.name}`} className={index === planIndex ? "active" : ""} aria-pressed={index === planIndex} onClick={() => selectPlan(index)}><span>{index + 1}</span>{stageLabels[item.name] ?? item.name}<small>{item.nodes.length}</small></button>)}</nav>
            {plan && <Graph plan={plan} selected={selected} onSelect={setSelected} zoom={zoom} />}
            {!plan && <p>No graph was captured before the error.</p>}
          </section>
          {node && <section className="panel details"><h2>#{node.id} {node.implementation}</h2><pre>{node.label}</pre><p>Output: {node.output_type} · Inputs: {node.inputs.length ? node.inputs.map(id => <button key={id} onClick={() => setSelected(id)}>#{id}</button>) : "none"}{node.dead_in_fit && " · Skipped during fit"}{node.recompute && " · Recomputed each pass"}</p><p className="muted">Node IDs belong to this stage.</p></section>}
          {plan && <section className="panel"><div className="panel-heading"><h2>Nodes <small>{nodes.length}</small></h2><input aria-label="Search playground nodes" placeholder="Search nodes…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="table-scroll"><table><thead><tr><th>Node</th><th>Operator</th><th>Inputs</th></tr></thead><tbody>{nodes.map(item => <tr key={item.id} className={selected === item.id ? "selected" : ""}><td><button onClick={() => setSelected(item.id)}>#{item.id}</button></td><td className="node-label">{item.label}</td><td>{item.inputs.join(", ") || "—"}</td></tr>)}</tbody></table></div></section>}
          {(result.stdout || result.stderr) && <section className="panel details"><details><summary>Python output</summary>{result.stdout && <pre>{result.stdout}</pre>}{result.stderr && <pre>{result.stderr}</pre>}</details></section>}
        </>}
      </div>
    </div>
  </>;
}
