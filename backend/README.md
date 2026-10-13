# Optimizer playground backend

This local service is separate from runtime execution and run-history storage.
It uses the local Stratum checkout from `pyproject.toml` plus Python's standard library; no
web-framework dependency is added to the engine.

From this repository's root, after `uv sync --extra test`:

```bash
uv run python -m backend.server
```

In another terminal, start the UI from this repository's root:

```bash
npm run dev
```

Open **http://127.0.0.1:3100/playground**. The backend binds to `127.0.0.1:3101`.
Run history and the playground can be used independently; the playground does
not need `STRATUM_DIAGNOSTICS_DIR`.

Write Python that assigns a skrub `DataOp` to `dag`, or change the output-variable
field to your variable's name. Code runs at the top level with
`__name__="__playground__"`; code inside a `__main__` guard is not executed.
The submitted code builds the DAG under `eager_data_ops=False`. The tool calls
the real logical optimizer and captures the input DAG, conversion, extraction,
CSE, choice unrolling and rewrite stages. Optional physical planning adds
lowering, implementation selection and the executable plan. It never calls the
scheduler or fits models on behalf of the user. Submitted Python itself can
perform arbitrary work, so use this only for trusted local code: it executes
with your user's filesystem, network and process permissions. The worker is
not a security sandbox.

Each stage includes an SVG rendered in memory by Stratum's native Graphviz
renderer, sharing labels, layout and edges with CLI `debug_graph` exports.
The playground displays that SVG directly; node IDs link clicks and keyboard
selection to the details table. Graphs are scrollable without a node-count cutoff.
The Graphviz `dot` executable must be installed (for example, `apt install graphviz`).

The backend loads Stratum and its scientific Python dependencies once before
reporting readiness. Each request gets a new child process from that preloaded
interpreter, using Python's forkserver rather than forking the threaded HTTP
server. Submitted code and flag changes do not leak between submissions. Relative
file paths resolve from this repository's root. Workers have a 30-second wall
limit after startup imports, and their process group is killed and reaped on
completion or timeout.
One submission runs at a time; concurrent submissions receive a busy response.
Request bodies are limited to 64 KiB, result/log files to 8 MiB each, and returned
stdout/stderr to 16 kB each. Python exceptions return structured tracebacks and
any plan stages already captured. No runtime artifact or GUI submission history
is written; disposable worker files are removed after the response.

The browser submits to Next.js's same-origin `/api/optimizer` route. That route
checks origin/content type/request size and proxies to the loopback Python
service. The Python service accepts JSON at `POST /optimize`, rejects browser
Origin headers and exposes no CORS access. `GET /health` reports readiness.
Both services are local development tools, without authentication.

To change the backend port or wall limit:

```bash
uv run python -m backend.server --port 3102 --timeout 60
# point the Next.js server to the same backend
STRATUM_OPTIMIZER_URL=http://127.0.0.1:3102 npm run dev
```

`STRATUM_OPTIMIZER_URL` is a server-only variable and must use a loopback HTTP
address. The backend timeout may be at most 90 seconds; the proxy allows 100.

Validation:

```bash
uv run python -m pytest backend
```
