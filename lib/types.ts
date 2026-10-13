export type Phase = {
  mode: string; fold: number; count: number; seconds: number;
  buffer_seconds: number; failures: number;
};
export type NodeTiming = {
  count: number; seconds: number; buffer_seconds: number; failures: number; phases: Phase[];
};
export type PlanNode = {
  id: number; label: string; implementation: string; inputs: number[];
  output_type: string; dead_in_fit: boolean; recompute: boolean;
};
export type Plan = { name: string; split_pos: number | null; nodes: PlanNode[]; svg?: string };
export type ResourceMetrics = {
  calls: number; wall_seconds: number; process_cpu_seconds: number; process_cpu_percent: number;
  tracking_seconds: number; memory_sample_count: number; calls_with_memory_samples: number;
  rss_mean_bytes: number | null; rss_peak_bytes: number | null;
};
export type HardwareSample = {
  time_seconds: number; interval_seconds: number; engine_rss_bytes: number; tree_rss_bytes: number;
  tree_cpu_percent: number | null; host_cpu_percent: number | null; host_memory_used_bytes: number;
};
export type Hardware = {
  status: "completed" | "unavailable"; error: string | null; interval_seconds: number;
  wall_seconds: number; process_cpu_seconds: number; process_cpu_percent: number; sample_count: number;
  summary: Record<string, number | null>; timeline: HardwareSample[];
  nodes: Record<string, ResourceMetrics & { phases: (ResourceMetrics & { mode: string; fold: number })[] }>;
  overhead: {
    startup_seconds: number; shutdown_seconds: number; aggregation_seconds: number;
    boundary_seconds: number; boundary_calls: number; service_cpu_seconds: number;
    service_peak_rss_bytes: number; sampling_seconds: number; sampling_calls: number;
    failed_samples: number; dropped_samples: number; dropped_windows: number;
  };
};
export type Run = {
  schema_version: 1; run_id: string; kind: string;
  started_at: string; finished_at: string; status: "completed" | "failed";
  error: { type: string; message: string; stage: string } | null;
  config: Record<string, unknown>; plans: Plan[];
  timings: { total: number; optimization: number | null; execution: number | null };
  node_timings: Record<string, NodeTiming>;
  heavy_hitters: { label: string; count: number; seconds: number }[];
  buffer_pool: Record<string, number> | null;
  hardware?: Hardware | null;
};
export type RunSummary = Pick<Run, "run_id" | "kind" | "started_at" | "status" | "timings">;
