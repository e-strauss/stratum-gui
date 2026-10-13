"use client";
import { useMemo, useState } from "react";
import type { Hardware, HardwareSample, ResourceMetrics } from "../../../lib/types";

const seconds = (value: number) => `${value.toFixed(6)} s`;
export const memory = (value: number | null | undefined) => value == null ? "—" : `${(value / 2 ** 20).toFixed(1)} MiB`;
export const cpuPercent = (value: number | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;

function Timeline({ samples, kind }: { samples: HardwareSample[]; kind: "cpu" | "memory" }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = useMemo(() => {
    const valid = samples.filter(s => kind === "memory" || s.tree_cpu_percent !== null);
    const value = (s: HardwareSample) => kind === "cpu" ? s.tree_cpu_percent! : s.tree_rss_bytes / 2 ** 20;
    const stride = Math.max(1, Math.ceil(valid.length / 400));
    const reduced = [];
    for (let i = 0; i < valid.length; i += stride) {
      reduced.push(valid.slice(i, i + stride).reduce((a, b) => value(a) >= value(b) ? a : b));
    }
    return reduced.map(sample => ({ sample, value: value(sample) }));
  }, [samples, kind]);
  if (!values.length) return <div className="chart-empty">No {kind === "cpu" ? "CPU intervals" : "memory samples"} collected for this run.</div>;
  const maxX = Math.max(.001, ...values.map(v => v.sample.time_seconds));
  const maxY = Math.max(1, ...values.map(v => v.value));
  const x = (time: number) => 66 + time / maxX * 620;
  const y = (value: number) => 164 - value / maxY * 140;
  const chosen = hover === null ? values[values.length - 1] : values[hover];
  const color = kind === "cpu" ? "#176759" : "#b7803c";
  return <div className="timeline">
    <svg viewBox="0 0 720 204" role="img" aria-label={kind === "cpu" ? "Sampled process-tree CPU utilization" : "Sampled process-tree resident memory"}
      onMouseLeave={() => setHover(null)} onMouseMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const time = Math.max(0, Math.min(maxX, ((event.clientX - rect.left) / rect.width * 720 - 66) / 620 * maxX));
        const nearest = values.reduce((best, v, i) => Math.abs(v.sample.time_seconds - time) < Math.abs(values[best].sample.time_seconds - time) ? i : best, 0);
        setHover(nearest);
      }}>
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1="66" x2="686" y1={y(maxY * fraction)} y2={y(maxY * fraction)} stroke="#e1e8e2" /><text x="55" y={y(maxY * fraction) + 4} textAnchor="end">{(maxY * fraction).toFixed(0)}</text></g>)}
      <path d={values.map((v, i) => `${i ? "L" : "M"}${x(v.sample.time_seconds)},${y(v.value)}`).join(" ")} fill="none" stroke={color} strokeWidth="2.5" />
      {values.length === 1 && <circle cx={x(values[0].sample.time_seconds)} cy={y(values[0].value)} r="4" fill={color} />}
      <text x="66" y="190">0 s</text><text x="686" y="190" textAnchor="end">{maxX.toFixed(2)} s</text>
      {hover !== null && <><line x1={x(chosen.sample.time_seconds)} x2={x(chosen.sample.time_seconds)} y1="24" y2="164" stroke="#899b91" strokeDasharray="3 3" /><circle cx={x(chosen.sample.time_seconds)} cy={y(chosen.value)} r="4" fill={color} /></>}
    </svg>
    <p className="chart-reading">{chosen.sample.time_seconds.toFixed(3)} s · {kind === "cpu" ? `${chosen.value.toFixed(1)}% tree CPU · ${cpuPercent(chosen.sample.host_cpu_percent ?? undefined)} host CPU` : `${memory(chosen.sample.tree_rss_bytes)} tree RSS · ${memory(chosen.sample.engine_rss_bytes)} engine RSS`}</p>
    {samples.length > 400 && <p className="muted chart-reading">Showing bucket maxima; exact samples remain in the artifact.</p>}
  </div>;
}

export function NodeResources({ resource }: { resource: ResourceMetrics & { phases: (ResourceMetrics & { mode: string; fold: number })[] } }) {
  return <div className="node-resources"><h3>Hardware observations</h3>
    <p>{cpuPercent(resource.process_cpu_percent)} engine CPU · {resource.process_cpu_seconds.toFixed(6)} core-s · {memory(resource.rss_peak_bytes)} observed tree peak RSS</p>
    <p className="muted">{resource.memory_sample_count} memory samples covering {resource.calls_with_memory_samples}/{resource.calls} calls. RSS is process-tree residency while this node ran. {resource.memory_sample_count === 0 && "This node was too short or outside the retained sampling window."}</p>
    <table><thead><tr><th>Phase / fold</th><th>Avg engine CPU</th><th>CPU core-s</th><th>Sample mean tree RSS</th><th>Peak tree RSS</th><th>RSS samples</th><th>Tracking API time</th></tr></thead><tbody>{resource.phases.map((phase, i) => <tr key={i}><td>{phase.mode} / {phase.fold < 0 ? "outside CV" : phase.fold + 1}</td><td>{cpuPercent(phase.process_cpu_percent)}</td><td>{phase.process_cpu_seconds.toFixed(6)}</td><td>{memory(phase.rss_mean_bytes)}</td><td>{memory(phase.rss_peak_bytes)}</td><td>{phase.memory_sample_count}</td><td>{seconds(phase.tracking_seconds)}</td></tr>)}</tbody></table>
  </div>;
}

export default function HardwareView({ hardware }: { hardware?: Hardware | null }) {
  if (!hardware) return <section className="empty"><h2>Hardware tracking was disabled</h2><p>Install the optional hardware extra and enable hardware_utilization for the next run.</p><pre>{'stratum.set_config(hardware_utilization=True,\n                   diagnostics_dir="/tmp/stratum-runs")'}</pre></section>;
  const overhead = hardware.overhead;
  const boundaryMean = overhead.boundary_calls ? overhead.boundary_seconds / overhead.boundary_calls * 1e6 : 0;
  return <>
    {hardware.error && <p className="alert">Tracker unavailable: {hardware.error}</p>}
    <div className="metrics">{[
      ["End-to-end wall (includes startup)", `${hardware.wall_seconds.toFixed(4)} s`],
      ["Average engine CPU", cpuPercent(hardware.process_cpu_percent)],
      ["Observed tree peak RSS", memory(hardware.summary.tree_rss_peak_bytes)],
      ["Hardware samples", hardware.sample_count.toLocaleString()],
    ].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <p className="muted">100% engine/tree CPU means one busy core; multithreaded work can exceed 100%. Host CPU uses machine capacity. RSS includes shared resident pages and cached buffers. Peaks are sampled, so brief allocations can be missed.</p>
    <div className="hardware-charts"><section className="panel"><div className="panel-heading"><div><h2>Process-tree CPU (%)</h2><p className="muted">Sampled engine + worker processes; the sampler is excluded.</p></div></div><Timeline samples={hardware.timeline} kind="cpu" /></section><section className="panel"><div className="panel-heading"><div><h2>Process-tree RSS (MiB)</h2><p className="muted">Resident memory sampled every {hardware.interval_seconds.toFixed(3)} s.</p></div></div><Timeline samples={hardware.timeline} kind="memory" /></section></div>
    <section className="panel"><div className="panel-heading"><div><h2>Tracking overhead</h2><p className="muted">Boundary calls use local counters, with zero per-node IPC. These measured costs are separate from operator processing time.</p></div></div><table><tbody>
      <tr><th>Operator boundary API calls</th><td>{seconds(overhead.boundary_seconds)} · {overhead.boundary_calls} calls · {boundaryMean.toFixed(2)} μs / call</td></tr>
      <tr><th>Sampler startup (included in end-to-end wall)</th><td>{seconds(overhead.startup_seconds)}</td></tr>
      <tr><th>Sampler shutdown / report transfer</th><td>{seconds(overhead.shutdown_seconds)}</td></tr>
      <tr><th>Join samples to node windows</th><td>{seconds(overhead.aggregation_seconds)}</td></tr>
      <tr><th>Sampler CPU / own peak RSS</th><td>{overhead.service_cpu_seconds.toFixed(6)} core-s / {memory(overhead.service_peak_rss_bytes)}</td></tr>
      <tr><th>Sampler collection wall time</th><td>{seconds(overhead.sampling_seconds)} / {overhead.sampling_calls} polls</td></tr>
      <tr><th>Loss / sampling errors</th><td>{overhead.dropped_samples} dropped timeline samples · {overhead.dropped_windows} dropped node windows · {overhead.failed_samples} failed polls</td></tr>
    </tbody></table></section>
  </>;
}
