import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { listRuns, parseRun, readRun } from "./runs.ts";
import type { Hardware } from "./types.ts";

const id = "a".repeat(32);
function sample() {
  return {
    schema_version: 1, run_id: id, kind: "evaluate", status: "completed",
    started_at: "2026-10-07T12:00:00Z", finished_at: "2026-10-07T12:00:01Z",
    error: null, config: {}, timings: { total: 1, optimization: .2, execution: .8 },
    plans: [{ name: "physical_impl", split_pos: null, nodes: [
      { id: 0, label: "source", implementation: "Source", inputs: [], output_type: "SCALAR", dead_in_fit: false, recompute: false },
      { id: 1, label: "call", implementation: "Call", inputs: [0], output_type: "SCALAR", dead_in_fit: false, recompute: false },
    ] }],
    node_timings: { "1": { count: 1, seconds: .1, buffer_seconds: .01, failures: 0,
      phases: [{ mode: "predict", fold: -1, count: 1, seconds: .1, buffer_seconds: .01, failures: 0 }] } },
    heavy_hitters: [{ label: "call", count: 1, seconds: .1 }], buffer_pool: { hits: 1 },
  };
}

test("rejects unsupported versions and invalid graph/timing references", () => {
  assert.equal(parseRun(JSON.stringify(sample())).run_id, id);
  const version = { ...sample(), schema_version: 2 };
  assert.throws(() => parseRun(JSON.stringify(version)), /Unsupported/);
  const cycle = sample(); cycle.plans[0].nodes[0].inputs = [1];
  assert.throws(() => parseRun(JSON.stringify(cycle)), /edges/);
  const timing = { ...sample(), node_timings: { "9": sample().node_timings["1"] } };
  assert.throws(() => parseRun(JSON.stringify(timing)), /timing/);
});

test("history ignores temporary files, reports malformed artifacts, and rejects traversal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stratum-reader-"));
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify(sample()));
  await writeFile(path.join(directory, `${"b".repeat(32)}.json`), "{");
  await writeFile(path.join(directory, ".unfinished.tmp"), "{");
  const history = await listRuns(directory);
  assert.equal(history.runs.length, 1);
  assert.equal(history.skipped, 1);
  await assert.rejects(readRun(directory, "../../outside"), /Invalid run ID/);
  const outside = await mkdtemp(path.join(tmpdir(), "stratum-outside-"));
  const file = path.join(outside, `${"c".repeat(32)}.json`);
  await writeFile(file, JSON.stringify(sample()));
  await symlink(file, path.join(directory, `${"c".repeat(32)}.json`));
  await assert.rejects(readRun(directory, "c".repeat(32)), /outside/);
});

test("a missing history directory is an empty state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stratum-empty-"));
  assert.deepEqual(await listRuns(path.join(directory, "missing")), { runs: [], skipped: 0 });
});

test("hardware is additive to v1, missing RSS stays null, and invalid hardware is rejected", () => {
  const resource = { calls: 1, wall_seconds: .1, process_cpu_seconds: .05, process_cpu_percent: 50,
    tracking_seconds: .00001, memory_sample_count: 0, calls_with_memory_samples: 0,
    rss_mean_bytes: null, rss_peak_bytes: null };
  const hardware: Hardware = {
    status: "completed", error: null, interval_seconds: .1, wall_seconds: 1,
    process_cpu_seconds: .1, process_cpu_percent: 10, sample_count: 0, summary: {}, timeline: [],
    nodes: { "1": { ...resource, phases: [{ ...resource, mode: "predict", fold: 0 }] } },
    overhead: { startup_seconds: .03, shutdown_seconds: .001, aggregation_seconds: .001,
      boundary_seconds: .00001, boundary_calls: 2, service_cpu_seconds: .005,
      service_peak_rss_bytes: 100, sampling_seconds: .001, sampling_calls: 0,
      failed_samples: 0, dropped_samples: 0, dropped_windows: 0 },
  };
  assert.equal(parseRun(JSON.stringify(sample())).hardware, undefined);
  const read = parseRun(JSON.stringify({ ...sample(), hardware }));
  assert.equal(read.hardware!.nodes["1"].rss_mean_bytes, null);
  hardware.overhead.boundary_seconds = -1;
  assert.throws(() => parseRun(JSON.stringify({ ...sample(), hardware })), /hardware/);
  hardware.overhead.boundary_seconds = 0;
  hardware.nodes = { "999": hardware.nodes["1"] };
  assert.throws(() => parseRun(JSON.stringify({ ...sample(), hardware })), /hardware/);
});
