"""One disposable Python process per playground submission."""
from __future__ import annotations

import json
from pathlib import Path
import resource
import sys
from time import perf_counter
import traceback

import stratum as st
from skrub import DataOp
from stratum.frontend._skrub_graph import build_graph, get_data
from stratum.optimizer._optimize import (
    OptConfig, logical_optimize, optimize, topological_traverse,
)
from stratum.optimizer._op_utils import graph_svg, plan_graph, topological_iterator
from stratum.runtime._diagnostics import capture_plans, capture_plan


def compile_plan(request):
    response = {"status": "completed", "plans": [], "error": None,
                "timings": {"preparation": 0.0, "optimization": 0.0}}
    stage = "code"
    start = perf_counter()
    with capture_plans(include_svg=True) as plans:
        try:
            scope = {"__name__": "__playground__"}
            # Build the DataOp DAG without skrub's eager preview evaluations.
            with st.config_context(eager_data_ops=False):
                exec(compile(request["code"], "<playground>", "exec"), scope)
            dag = scope.get(request["target"])
            if not isinstance(dag, DataOp):
                raise ValueError(f"Define `{request['target']}` as a skrub DataOp at the top level.")
            stage = "skrub_graph"
            graph = build_graph(dag)
            order = topological_traverse(graph["nodes"], graph["parents"], graph["children"])
            ids = {key: i for i, key in enumerate(order)}
            plans.append({"name": "skrub", "split_pos": None, "nodes": [
                {"id": ids[key], "label": repr(graph["nodes"][key]._skrub_impl)[:500],
                 "implementation": type(graph["nodes"][key]._skrub_impl).__name__,
                 "inputs": [ids[child] for child in graph["children"].get(key, [])],
                 "output_type": "DataOp", "dead_in_fit": False, "recompute": False}
                for key in order
            ]})
            plans[-1]["svg"] = graph_svg(plan_graph(plans[-1]["nodes"], "skrub"))
            stage = "optimization"
            response["timings"]["preparation"] = perf_counter() - start
            start = perf_counter()
            config = OptConfig(**request["options"])
            # CSE currently reads FLAGS.cse. Match it to the playground switch.
            with st.config(cse=config.cse, implementation_selector=request["selector"],
                           diagnostics_dir=None, hardware_utilization=False,
                           debug_graph=False, open_graph=False, explain=False, stats=False):
                env = get_data(dag) if request["resolve_variables"] else None
                if request["phase"] == "physical":
                    optimize(dag, config=config, env=env)
                else:
                    root = logical_optimize(dag, config=config, env=env)
                    capture_plan("logical", topological_iterator(root))
        except BaseException as exc:
            response["status"] = "failed"
            response["error"] = {"stage": stage, "type": type(exc).__name__,
                                 "message": str(exc)[:4000], "traceback": traceback.format_exc()[-12000:]}
        finally:
            response["timings"]["optimization" if stage == "optimization" else "preparation"] = perf_counter() - start
            response["plans"] = plans
    return response


def run_files(request_path, result_path):
    # Bound log/result files from accidental print loops. This is not a sandbox.
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    request = json.loads(Path(request_path).read_text())
    response = compile_plan(request)
    Path(result_path).write_text(json.dumps(response, allow_nan=False))


def main():
    run_files(sys.argv[1], sys.argv[2])


if __name__ == "__main__":
    main()
