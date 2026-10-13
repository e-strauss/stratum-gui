"use client";
import { useMemo, useState } from "react";
import type { Run } from "../../../lib/types";
import Graph from "../../components/plan-graph";
import HardwareView, { NodeResources, cpuPercent, memory } from "./hardware";

const seconds = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(4)} s`;

export default function Inspector({ run, initialView = "plan" }: { run: Run; initialView?: string }) {
  const [tab, setTab] = useState(initialView);
  const [planIndex, setPlanIndex] = useState(Math.max(0, run.plans.findIndex(p => p.name === "physical_impl")));
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("time");
  const plan = run.plans[planIndex];
  const timings = plan?.name === "physical_impl" ? run.node_timings : {};
  const node = plan?.nodes.find(n => n.id === selected);
  const timing = selected === null ? undefined : timings[selected];
  const resources = plan?.name === "physical_impl" ? run.hardware?.nodes ?? {} : {};
  const resource = selected === null ? undefined : resources[selected];
  const nodes = useMemo(() => {
    const filtered = (plan?.nodes ?? []).filter(n => `${n.id} ${n.label}`.toLowerCase().includes(query.toLowerCase()));
    return sort === "time" ? filtered.sort((a, b) => (timings[b.id]?.seconds ?? 0) - (timings[a.id]?.seconds ?? 0)) : filtered;
  }, [plan, query, sort, timings]);
  const operatorTime = run.heavy_hitters.reduce((sum, row) => sum + row.seconds, 0);
  return <>
    <div className="heading"><div><p className="eyebrow">{run.run_id.slice(0, 8)} · {new Date(run.started_at).toLocaleString()}</p><h1>{run.kind === "grid_search" ? "Grid search" : "Evaluation"}</h1><p>Plans, operator costs and buffer activity for this execution.</p></div><span className={`badge ${run.status}`}>{run.status}</span></div>
    {run.error && <div className="alert"><strong>{run.error.stage}: {run.error.type}</strong><pre>{run.error.message}</pre></div>}
    <div className="metrics">{[["Total", run.timings.total], ["Optimization", run.timings.optimization], ["Execution", run.timings.execution], ["Operator processing", operatorTime]].map(([label, time]) => <div className="metric" key={String(label)}><span>{label}</span><strong>{seconds(time as number | null)}</strong></div>)}</div>
    <nav className="tabs" aria-label="Run views">{[["plan", "Plans & nodes"], ["hitters", "Heavy hitters"], ["hardware", "Hardware & overhead"], ["buffer", "Buffer pool"], ["config", "Configuration"]].map(([id, label]) => <button key={id} aria-pressed={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === "plan" && <>
      <section className="panel"><div className="panel-heading"><div><h2>Dependency plan</h2><p className="muted">Select a node to inspect its calls. Warmer nodes spent more time processing.</p></div><label>Snapshot <select value={planIndex} onChange={e => { setPlanIndex(Number(e.target.value)); setSelected(null); }}>{run.plans.map((p, i) => <option key={i} value={i}>{p.name}</option>)}</select></label></div>
        {plan ? <Graph plan={plan} timings={timings} selected={selected} onSelect={setSelected} /> : <p>No plan was captured before this run failed.</p>}
      </section>
      {node && <section className="panel details"><h2>#{node.id} {node.label}</h2><p>Inputs: {node.inputs.length ? node.inputs.map(id => <button key={id} onClick={() => setSelected(id)}>#{id}</button>) : "none"} · Output: {node.output_type}{node.dead_in_fit && " · Skipped during fit"}{node.recompute && " · Recomputed each pass"}</p>
        {timing ? <><p>{timing.count} calls · {seconds(timing.seconds)} processing · {seconds(timing.buffer_seconds)} buffer work · {timing.failures} failures</p><table><thead><tr><th>Phase</th><th>Fold</th><th>Calls</th><th>Processing</th><th>Buffer work</th><th>Failures</th></tr></thead><tbody>{timing.phases.map((p, i) => <tr key={i}><td>{p.mode}</td><td>{p.fold < 0 ? "pre-CV / holdout" : p.fold + 1}</td><td>{p.count}</td><td>{seconds(p.seconds)}</td><td>{seconds(p.buffer_seconds)}</td><td>{p.failures}</td></tr>)}</tbody></table></> : <p className="muted">{plan.name === "physical_impl" ? "No processing calls recorded for this node." : "Runtime measurements belong to the physical_impl snapshot."}</p>}
        {resource && <NodeResources resource={resource} />}
      </section>}
      <section className="panel"><div className="panel-heading"><h2>Nodes <small>{nodes.length}</small></h2><div className="controls"><input aria-label="Search nodes" placeholder="Search node or implementation…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Sort nodes" value={sort} onChange={e => setSort(e.target.value)}><option value="time">Processing time</option><option value="plan">Plan order</option></select></div></div>
        <div className="table-scroll"><table><thead><tr><th>Node</th><th>Implementation</th><th>Inputs</th><th>Calls</th><th>Processing</th><th>Buffer work</th>{run.hardware && <><th>Avg engine CPU</th><th>Observed tree peak RSS</th></>}</tr></thead><tbody>{nodes.map(n => <tr key={n.id} className={selected === n.id ? "selected" : ""}><td><button onClick={() => setSelected(n.id)}>#{n.id}</button></td><td className="node-label">{n.label}</td><td>{n.inputs.join(", ") || "—"}</td><td>{timings[n.id]?.count ?? "—"}</td><td className="numeric">{seconds(timings[n.id]?.seconds)}</td><td className="numeric">{seconds(timings[n.id]?.buffer_seconds)}</td>{run.hardware && <><td className="numeric">{cpuPercent(resources[n.id]?.process_cpu_percent)}</td><td className="numeric">{memory(resources[n.id]?.rss_peak_bytes)}</td></>}</tr>)}</tbody></table></div>
      </section>
    </>}
    {tab === "hitters" && <section className="panel"><div className="panel-heading"><div><h2>Heavy hitters</h2><p className="muted">Grouped by display label. Percentages use all operator processing time.</p></div></div><table><thead><tr><th>Operator</th><th>Calls</th><th>Processing</th><th>Share</th></tr></thead><tbody>{run.heavy_hitters.map(row => <tr key={row.label}><td>{row.label}</td><td>{row.count}</td><td className="numeric">{seconds(row.seconds)}</td><td><div className="share"><span style={{ width: `${operatorTime ? 100 * row.seconds / operatorTime : 0}%` }} /></div>{operatorTime ? (100 * row.seconds / operatorTime).toFixed(1) : "0.0"}%</td></tr>)}</tbody></table></section>}
    {tab === "buffer" && <section className="panel"><div className="panel-heading"><div><h2>Buffer pool</h2><p className="muted">Serialization and deserialization are included in execution time.</p></div></div><table><tbody>{Object.entries(run.buffer_pool ?? {}).map(([key, value]) => <tr key={key}><th>{key.replaceAll("_", " ")}</th><td className="numeric">{key.endsWith("time") ? seconds(value) : value.toLocaleString()}</td></tr>)}</tbody></table>{!run.buffer_pool && <p className="muted">Execution did not start.</p>}</section>}
    {tab === "hardware" && <HardwareView hardware={run.hardware} />}
    {tab === "config" && <section className="panel"><div className="panel-heading"><h2>Run configuration</h2></div><table><tbody>{Object.entries(run.config).map(([key, value]) => <tr key={key}><th>{key}</th><td><code>{JSON.stringify(value)}</code></td></tr>)}</tbody></table></section>}
  </>;
}
