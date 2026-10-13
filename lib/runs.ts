import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Run, RunSummary } from "./types.ts";

const validId = /^[a-f0-9]{32}$/;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const valuesAreNumbers = (v: unknown) => object(v) && Object.values(v).every(number);

export function parseRun(raw: string): Run {
  const run = JSON.parse(raw);
  const timing = (v: unknown) => object(v) && number(v.count) && number(v.seconds) &&
    number(v.buffer_seconds) && number(v.failures);
  if (!object(run) || run.schema_version !== 1 || typeof run.run_id !== "string" || !validId.test(run.run_id) ||
      !["completed", "failed"].includes(String(run.status)) || typeof run.kind !== "string" ||
      typeof run.started_at !== "string" || !Number.isFinite(Date.parse(run.started_at)) ||
      typeof run.finished_at !== "string" || !Number.isFinite(Date.parse(run.finished_at)) ||
      !object(run.config) || !object(run.timings) || !number(run.timings.total) ||
      !(run.timings.optimization === null || number(run.timings.optimization)) ||
      !(run.timings.execution === null || number(run.timings.execution)) ||
      !(run.error === null || (object(run.error) && [run.error.type, run.error.message, run.error.stage].every(v => typeof v === "string"))) ||
      !(run.buffer_pool === null || valuesAreNumbers(run.buffer_pool)) ||
      !Array.isArray(run.plans) || !object(run.node_timings) || !Array.isArray(run.heavy_hitters)) {
    throw new Error("Unsupported or invalid run artifact");
  }
  for (const plan of run.plans) {
    if (!object(plan) || typeof plan.name !== "string" || !Array.isArray(plan.nodes) ||
        !(plan.split_pos === null || (Number.isInteger(plan.split_pos) && Number(plan.split_pos) >= 0 && Number(plan.split_pos) < plan.nodes.length))) {
      throw new Error("Invalid plan");
    }
    const ids = new Set(plan.nodes.map(n => n.id));
    if (ids.size !== plan.nodes.length || !plan.nodes.every((node, i) =>
      object(node) && node.id === i && typeof node.label === "string" && typeof node.implementation === "string" &&
      typeof node.output_type === "string" && typeof node.dead_in_fit === "boolean" && typeof node.recompute === "boolean" &&
      Array.isArray(node.inputs) && node.inputs.every(id => Number.isInteger(id) && ids.has(id) && id < i))) {
      throw new Error("Invalid plan nodes or edges");
    }
  }
  for (const [id, value] of Object.entries(run.node_timings)) {
    const executable = run.plans.find(p => p.name === "physical_impl");
    if (!/^\d+$/.test(id) || !executable?.nodes.some((n: { id: number }) => n.id === Number(id)) ||
        !object(value) || !timing(value) || !Array.isArray(value.phases) || !value.phases.every(p =>
          object(p) && timing(p) && typeof p.mode === "string" && Number.isInteger(p.fold) && Number(p.fold) >= -1)) {
      throw new Error("Invalid node timing");
    }
  }
  if (!run.heavy_hitters.every(h => object(h) && typeof h.label === "string" && number(h.count) && number(h.seconds))) {
    throw new Error("Invalid heavy hitters");
  }
  if (run.hardware !== undefined && run.hardware !== null) validateHardware(run.hardware, run.plans);
  return run as Run;
}

function validateHardware(raw: unknown, plans: unknown[]) {
  const nullable = (value: unknown) => value === null || number(value);
  const metrics = (v: unknown) => object(v) &&
    [v.calls, v.wall_seconds, v.process_cpu_seconds, v.process_cpu_percent, v.tracking_seconds,
      v.memory_sample_count, v.calls_with_memory_samples].every(number) &&
    [v.rss_mean_bytes, v.rss_peak_bytes].every(nullable);
  if (!object(raw) || !["completed", "unavailable"].includes(String(raw.status)) ||
      !(raw.error === null || typeof raw.error === "string") ||
      ![raw.interval_seconds, raw.wall_seconds, raw.process_cpu_seconds, raw.process_cpu_percent, raw.sample_count].every(number) ||
      !object(raw.summary) || !Object.values(raw.summary).every(nullable) ||
      !object(raw.overhead) || !valuesAreNumbers(raw.overhead) ||
      !["startup_seconds", "shutdown_seconds", "aggregation_seconds", "boundary_seconds", "boundary_calls", "service_cpu_seconds", "service_peak_rss_bytes", "sampling_seconds", "sampling_calls", "failed_samples", "dropped_samples", "dropped_windows"].every(key => number(raw.overhead && (raw.overhead as Record<string, unknown>)[key])) ||
      !Array.isArray(raw.timeline) || !raw.timeline.every(s => object(s) &&
        [s.time_seconds, s.interval_seconds, s.engine_rss_bytes, s.tree_rss_bytes, s.host_memory_used_bytes].every(number) &&
        [s.tree_cpu_percent, s.host_cpu_percent].every(nullable)) || !object(raw.nodes)) {
    throw new Error("Invalid hardware measurements");
  }
  const executable = plans.find(p => object(p) && p.name === "physical_impl") as { nodes: { id: number }[] } | undefined;
  for (const [id, value] of Object.entries(raw.nodes)) {
    if (!/^\d+$/.test(id) || !executable?.nodes.some(n => n.id === Number(id)) || !object(value) ||
        !metrics(value) || !Array.isArray(value.phases) || !value.phases.every(p => object(p) && metrics(p) &&
          typeof p.mode === "string" && Number.isInteger(p.fold) && Number(p.fold) >= -1)) {
      throw new Error("Invalid node hardware measurements");
    }
  }
}

// One bounded cache shared by server renders. No engine imports or callbacks.
const cache = new Map<string, { stamp: string; run: Run; bytes: number }>();
let cachedBytes = 0;
const cacheBudget = 32 * 1024 * 1024;
export function runsDirectory() {
  return process.env.STRATUM_DIAGNOSTICS_DIR;
}

export async function readRun(directory: string, id: string): Promise<Run> {
  if (!validId.test(id)) throw new Error("Invalid run ID");
  const root = await realpath(directory);
  const file = await realpath(path.join(root, `${id}.json`));
  if (path.dirname(file) !== root) throw new Error("Artifact is outside the diagnostics directory");
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Artifact exceeds the 64 MiB reader limit");
  const stamp = `${info.mtimeMs}:${info.size}`;
  const previous = cache.get(file);
  if (previous?.stamp === stamp) return previous.run;
  const run = parseRun(await readFile(file, "utf8"));
  if (run.run_id !== id) throw new Error("Artifact ID does not match its filename");
  if (previous) { cachedBytes -= previous.bytes; cache.delete(file); }
  if (info.size <= cacheBudget) {
    while (cache.size && (cache.size >= 128 || cachedBytes + info.size > cacheBudget)) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(file, { stamp, run, bytes: info.size });
    cachedBytes += info.size;
  }
  return run;
}

export async function listRuns(directory: string): Promise<{ runs: RunSummary[]; skipped: number }> {
  let files;
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], skipped: 0 };
    throw error;
  }
  const ids = files.filter(file => /^[a-f0-9]{32}\.json$/.test(file)).map(file => file.slice(0, -5));
  const runs: RunSummary[] = [];
  let skipped = 0;
  // Bound disk concurrency so a history refresh cannot flood the compute host.
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.allSettled(ids.slice(i, i + 8).map(id => readRun(directory, id)));
    for (const result of batch) {
      if (result.status === "fulfilled") {
        const { run_id, kind, started_at, status, timings } = result.value;
        runs.push({ run_id, kind, started_at, status, timings });
      } else { skipped++; }
    }
  }
  runs.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return { runs, skipped };
}
