# Stratum Inspector

The Next.js app needs only Node.js. The optional playground backend uses the
local Stratum checkout configured in `pyproject.toml` (`../stratum` by default);
run `uv sync --extra test` once to install it.

A separate Next.js application for local execution history. It reads versioned
JSON artifacts; it never imports Stratum, connects to Python, or starts an engine.
Its dependencies and build are independent of the Python package.

Enable export in the program that runs Stratum:

```python
import stratum

stratum.set_config(
    scheduler=True,
    diagnostics_dir="/tmp/stratum-runs",
    hardware_utilization=True,  # optional; requires stratum-ai[hardware]
)
```

Start the inspector in a second terminal (Node.js 20.9+):

```bash
cd stratum-gui
npm ci
STRATUM_DIAGNOSTICS_DIR=/tmp/stratum-runs npm run dev
```

Open http://127.0.0.1:3100. Use the same **absolute path** in both processes.
For a production local server, run `npm run build`, then set the same environment
variable when running `npm start`. The browser accesses Next.js; only the Next.js
server reads the filesystem. A read-only directory mount also works when running
the GUI in a container on the same host.

Run history refreshes every ten seconds while the page is visible. Completed and
failed runs contain plan snapshots, a physical plan annotated with timings,
per-node fit/predict and fold breakdowns, heavy hitters, buffer statistics, and
the configuration snapshot. IDs are local to each plan snapshot. Runtime
measurements reference only the final `physical_impl` snapshot. Nodes with the
same label remain separate in that view.

The **Hardware & overhead** tab shows a CPU/RSS timeline, end-to-end CPU and
memory summaries, and the profiler's own costs. Physical nodes show engine CPU
time/utilization plus sampled tree RSS, including a phase/fold breakdown and
sample coverage. Install the optional dependency with
`uv sync --extra test --extra hardware` in a development checkout. The sampling
interval defaults to 100 ms; use `hardware_sampling_interval=0.05` for 50 ms.
Old artifacts remain readable and show that hardware collection was disabled.

Sampling runs in a small separate Python interpreter and excludes that sampler
from process-tree CPU/RSS. Operator boundaries have no RPC or IPC: they read the
engine process's CPU clock and record local execution windows. Joining those
windows to memory samples happens after execution. The display separates
startup, shutdown, aggregation, local boundary call time, and sampler CPU/RSS.
Short nodes can have no memory sample; those values are **unavailable**, never
zero. RSS describes process-tree residency while a node ran, including cached
buffers and other resident state; it is not the node's exclusive allocation.

For a larger run using the NYC application test's pipeline and generated data,
run this from the Stratum source checkout root:

```bash
.venv/bin/python examples/nyc_hardware_utilization.py \
    --lots 80000 --events 800000 --threads 4 \
    --diagnostics-dir /tmp/stratum-runs
```

`--events` specifies the size of each event table. Data generation happens before
the measured API run; the exported run includes feature extraction, vectorization
and histogram boosting with the test's expanding-window CV.

This first version exports once after execution, including exception paths.
There is no live progress or recovery after SIGKILL. JSON serialization and disk
I/O occur before the API returns, outside measured computation time. Enabling
diagnostics costs plan traversals and small in-memory counter updates. Disabled
export performs no graph capture or filesystem work; `stats=True` still retains
per-node aggregates in `scheduler.node_timings` for programmatic analysis.

The UI draws graphs up to 250 nodes and provides a searchable table for larger
plans. The reader rejects unsupported schemas and malformed artifacts, restricts
reads to the configured directory, and limits each artifact to 64 MiB. Keep this
local inspector on loopback; it has no authentication. The exporter includes
labels and error messages but never serializes datasets, predictions, estimator
objects, or arbitrary operator parameters.

```bash
npm run typecheck
npm test
npm run build
```

See [the integration design](https://github.com/deem-data/stratum/blob/main/docs/runtime-inspector.md) for the contract and
the proposed live event-log extension.

See the [optimizer playground backend](backend/README.md) for the independent
Python-code workbench at `/playground`. Start its service from this repository's root
with `uv run python -m backend.server`; it uses port **3101** and needs no
runtime diagnostics directory.
