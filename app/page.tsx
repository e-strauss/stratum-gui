import Link from "next/link";
import { listRuns, runsDirectory } from "../lib/runs";
import Refresh from "./refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  const directory = runsDirectory();
  let history: Awaited<ReturnType<typeof listRuns>> = { runs: [], skipped: 0 };
  let error = "";
  if (directory) {
    try { history = await listRuns(directory); }
    catch { error = "Could not read the diagnostics directory. Check the path and read permissions."; }
  }
  return <>
    <div className="heading"><div><p className="eyebrow">EXECUTION OBSERVATORY</p><h1>Run history</h1><p>Explore where time went, from rewrite to execution.</p></div><Refresh /></div>
    {!directory && <section className="empty"><h2>Connect your local runs</h2><p>Point the inspector and Stratum at the same directory.</p><pre>{'stratum.set_config(diagnostics_dir="/tmp/stratum-runs")\n\n# Start the inspector from stratum-gui/\nSTRATUM_DIAGNOSTICS_DIR=/tmp/stratum-runs npm run dev'}</pre></section>}
    {error && <p className="alert">{error}</p>}
    {directory && !error && history.runs.length === 0 && <section className="empty"><h2>Waiting for your first run</h2><p>Completed and failed runs appear here after execution finishes. History refreshes every 10 seconds.</p></section>}
    {history.skipped > 0 && <p className="alert">Skipped {history.skipped} unreadable, invalid or unsupported artifacts.</p>}
    {history.runs.length > 0 && <section className="panel"><table><thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Total</th><th>Optimization</th><th>Execution</th></tr></thead><tbody>
      {history.runs.map(run => <tr key={run.run_id}><td><Link href={`/runs/${run.run_id}`} className="run-link">{run.kind} <small>{run.run_id.slice(0, 8)}</small></Link></td><td>{new Date(run.started_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</td><td><span className={`badge ${run.status}`}>{run.status}</span></td>{[run.timings.total, run.timings.optimization, run.timings.execution].map((time, i) => <td key={i} className="numeric">{time === null ? "—" : `${time.toFixed(4)} s`}</td>)}</tr>)}
    </tbody></table></section>}
  </>;
}
