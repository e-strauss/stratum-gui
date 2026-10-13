"""Planning-only behavior, actual rewrite controls and worker failure isolation."""
import os
from pathlib import Path
import re
import threading
import xml.etree.ElementTree as ET

import pytest

from backend import service
from backend.worker import compile_plan
from stratum.runtime._diagnostics import capture_plans, capture_plan, diagnostics_enabled


SOURCE = Path(__file__).parents[1] / "lib/playground.ts"
SHIPPED = re.findall(r'name: "([^"]+)",(?: phase: "\w+",)?(?: selector: "(\w+)",)? code: `([^`]+)`',
                     SOURCE.read_text())
PHYSICAL = re.findall(r'name: "([^"]+)", phase: "physical",', SOURCE.read_text())
EXAMPLES = [code for _, _, code in SHIPPED]


@pytest.mark.parametrize("name,selector,code", SHIPPED, ids=[name for name, _, _ in SHIPPED])
@pytest.mark.parametrize("phase", ["logical", "physical"])
def test_shipped_examples_plan_without_processing(name, selector, code, phase, tmp_path, monkeypatch):
    from sklearn.linear_model import Ridge
    from stratum.runtime._scheduler import SequentialScheduler

    def forbid(*args, **kwargs):
        raise AssertionError("The playground must only plan.")

    monkeypatch.setattr(Ridge, "fit", forbid)
    monkeypatch.setattr(SequentialScheduler, "process_op", forbid)
    monkeypatch.chdir(tmp_path)
    result = compile_plan(service.validate_request(
        {"code": code, "phase": phase, "selector": selector or "default"}))
    assert result["status"] == "completed", result["error"]
    names = [plan["name"] for plan in result["plans"]]
    assert names[0] == "skrub"
    assert {"conversion", "frame_rewrite", "op_cse", "unrolled", "logical"} <= set(names)
    assert ("physical_impl" in names) == (phase == "physical")
    for plan in result["plans"]:
        svg = ET.fromstring(plan["svg"])
        groups = svg.findall(".//{http://www.w3.org/2000/svg}g")
        graph_nodes = [g for g in groups if g.get("class") == "node"]
        assert {g.get("id") for g in graph_nodes} == {f"node-{n['id']}" for n in plan["nodes"]}
        graph_edges = [g for g in groups if g.get("class") == "edge"]
        assert len(graph_edges) == sum(len(n["inputs"]) for n in plan["nodes"])
        for node in plan["nodes"]:
            assert all(child < node["id"] for child in node["inputs"])
    assert not list(tmp_path.iterdir())
    assert not diagnostics_enabled()


def test_capture_restores_nested_sink_after_error():
    from stratum.optimizer.logical._ops import Op

    op = Op()
    with capture_plans() as outer:
        capture_plan("outer", [op])
        with pytest.raises(ValueError):
            with capture_plans() as inner:
                capture_plan("inner", [op])
                raise ValueError("stop")
        capture_plan("restored", [op])
    assert [p["name"] for p in outer] == ["outer", "restored"]
    assert [p["name"] for p in inner] == ["inner"]
    assert not diagnostics_enabled()


def test_cse_switch_changes_plan_and_passes_can_be_disabled():
    code = '''import pandas as pd
import skrub
data = skrub.var("data", pd.DataFrame({"x": [1,2,3]}))
a = data[["x"]] + 1
b = data[["x"]] + 1
dag = a + b
'''
    enabled = compile_plan(service.validate_request({"code": code}))
    disabled = compile_plan(service.validate_request({"code": code, "options": {key: False for key in service.OPTIONS}}))
    assert enabled["status"] == disabled["status"] == "completed"
    names = {p["name"] for p in disabled["plans"]}
    assert not {"op_cse", "unrolled", "algebraic_rewrite", "frame_rewrite", "numeric_rewrite"} & names
    before = next(p for p in enabled["plans"] if p["name"] == "numeric_rewrite")
    after = next(p for p in enabled["plans"] if p["name"] == "op_cse")
    assert len(after["nodes"]) < len(before["nodes"])


def test_captured_svg_matches_native_cli_export(tmp_path, monkeypatch):
    import stratum as st
    from stratum.optimizer._optimize import convert_to_ops
    from stratum.optimizer._op_utils import show_graph, topological_iterator

    monkeypatch.chdir(tmp_path)
    dag = st.as_data_op(1) + 2
    root = convert_to_ops(dag)
    with st.config(graph_format="svg"), capture_plans(include_svg=True) as plans:
        capture_plan("checkpoint", topological_iterator(root))
        show_graph(root, "checkpoint")
    exported = (tmp_path / "graphs/checkpoint.svg").read_text()
    assert plans[0]["svg"] == exported[exported.index("<svg"):]
    with capture_plans() as plain:
        capture_plan("without_svg", topological_iterator(root))
    assert "svg" not in plain[0]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_complex_feature_example_folds_and_evaluates(backend):
    import pandas as pd
    import polars as pl
    import stratum as st
    from stratum.frontend._skrub_graph import build_graph, get_data
    from stratum.optimizer._optimize import OptConfig, logical_optimize
    from stratum.optimizer._op_utils import topological_iterator
    from stratum.optimizer.logical._map_ops import AssignMapOp
    from stratum.optimizer.physical._map_execs import PandasAssignMapOp, PolarsAssignMapOp

    scope = {"__name__": "__playground__"}
    code = re.search(r'name: "Complex feature map", code: `([^`]+)`', SOURCE.read_text()).group(1)
    with st.config_context(eager_data_ops=False):
        exec(code, scope)
    dag = scope["dag"]
    assert len(build_graph(dag)["nodes"]) > 90
    frame = get_data(dag)["orders"]
    with st.config():
        root = logical_optimize(dag, OptConfig(), env={"orders": frame})
    ops = list(topological_iterator(root))
    assert len(ops) == 2
    assert isinstance(root, AssignMapOp)
    assert len(root.inputs) == 1
    assert len(root.entries) == 38

    if backend == "polars":
        result = PolarsAssignMapOp(entries=root.entries).process("fit_transform", [pl.from_pandas(frame)]).to_pandas()
    else:
        result = PandasAssignMapOp(entries=root.entries).process("fit_transform", [frame])
    assert len(result.columns) == len(frame.columns) + 38
    assert result["quantity_clean"].tolist() == [2., 12., 0., 1., 4., 8.]
    assert result["discount_clean"].tolist() == [0.1, 0.25, 0., 0., 1., 0.]
    assert result["net_amount"].tolist() == pytest.approx([89.1, 1080., 0., 0., 0., 180.])
    assert result["positive_margin"].tolist() == pytest.approx([49.1, 180., 0., 0., 0., 84.])
    assert result["customer_clean"].tolist() == ["alice smith", "bob", "unknown", "chandra", "dora", "emil"]
    assert result["product_digit_count"].tolist() == [3] * 6
    assert result["is_example_email"].tolist() == [True, False, False, True, False, True]
    assert result["priority_market"].tolist() == [True, True, False, False, True, True]
    assert result["discount_missing"].tolist() == [False, False, True, False, False, False]
    assert result["order_month"].dropna().tolist() == [1, 2, 3, 6, 12]
    assert result["order_quarter"].dropna().tolist() == [1, 1, 1, 2, 4]
    assert pd.isna(result.loc[2, "ordered_at_parsed"])
    assert result.loc[0, "is_month_end"]
    assert result["feature_version"].tolist() == [1] * 6


@pytest.mark.parametrize("code,kind", [("not python !", "SyntaxError"), ("dag = 1", "ValueError"), ("raise RuntimeError('bad code')", "RuntimeError")])
def test_code_errors_return_structured_details(code, kind):
    result = compile_plan(service.validate_request({"code": code}))
    assert result["status"] == "failed"
    assert result["error"]["type"] == kind
    assert result["error"]["stage"] == "code"
    assert "<playground>" in result["error"]["traceback"] or kind == "ValueError"


def test_partial_stages_survive_optimizer_failure(monkeypatch):
    import importlib
    optimizer = importlib.import_module("stratum.optimizer._optimize")

    def fail(*args):
        raise ValueError("schema failure")

    monkeypatch.setattr(optimizer, "propagate_output_schema", fail)
    result = compile_plan(service.validate_request({"code": EXAMPLES[0]}))
    assert result["status"] == "failed"
    assert result["error"]["stage"] == "optimization"
    assert "conversion" in {p["name"] for p in result["plans"]}


def _executable(name):
    [(selector, code)] = [(selector, code) for example, selector, code in SHIPPED if example == name]
    result = compile_plan(service.validate_request(
        {"code": code, "phase": "physical", "selector": selector or "default"}))
    assert result["status"] == "completed", result["error"]
    return [node["label"].split("(")[0] for node in result["plans"][-1]["nodes"]]


# The executable plan each physical example is there to show.
EXECUTABLE = {
    "Default selector: all pandas": ["PandasInMemoryFrame", "PandasAssignMapOp"],
    "Greedy: all polars": ["PolarsInMemoryFrame", "PolarsAssignMapOp"],
    "pandas call between polars ops": [
        "PolarsInMemoryFrame", "PolarsColumnProjectionOp", "ConversionOp", "BinOp",
        "ConversionOp", "MethodCallExec", "ConversionOp", "PolarsAssignMapOp"],
    "One conversion per producer": [
        "PolarsInMemoryFrame", "PolarsColumnProjectionOp", "ConversionOp", "BinOp",
        "ConversionOp", "MethodCallExec", "ConversionOp", "MethodCallExec", "ConversionOp",
        "PolarsAssignMapOp"],
    "Portable regex stays polars": ["PolarsInMemoryFrame", "PolarsAssignMapOp"],
    "Unportable regex: map on pandas": ["PolarsInMemoryFrame", "ConversionOp", "PandasAssignMapOp"],
    "Unportable string method": [
        "PolarsInMemoryFrame", "PolarsColumnProjectionOp", "ConversionOp", "PandasStringMethodOp"],
    "drop: columns polars, rows pandas": [
        "PolarsInMemoryFrame", "PolarsDropOp", "ConversionOp", "PandasDropOp"],
    "pandas-only constant": ["PolarsInMemoryFrame", "ConversionOp", "PandasAssignMapOp"],
    "Duration stays polars": ["PolarsInMemoryFrame", "PolarsAssignMapOp"],
    "Same rows stay polars": ["PolarsInMemoryFrame", "PolarsSelectionOp", "PolarsAssignMapOp"],
    "Index labels keep pandas": [
        "PolarsInMemoryFrame", "ConversionOp", "PandasIndexSelectionOp", "PandasIndexAccessOp",
        "PandasAssignMapOp"],
    "Label alignment keeps pandas": [
        "PolarsInMemoryFrame", "ConversionOp", "PolarsColumnProjectionOp", "ConversionOp",
        "PandasIndexSelectionOp", "PandasAssignMapOp"],
    "Group labels keep pandas": [
        "PolarsInMemoryFrame", "ConversionOp", "PandasAggregateOp", "MethodCallExec"],
    "Renumbered rows stay polars": [
        "PolarsInMemoryFrame", "PolarsSortOp", "PolarsMetadataOp", "PolarsAssignMapOp"],
}


def test_every_physical_example_has_an_expected_plan():
    assert set(PHYSICAL) == set(EXECUTABLE)


@pytest.mark.parametrize("name", EXECUTABLE)
def test_physical_examples_show_their_executable_plan(name):
    assert _executable(name) == EXECUTABLE[name]


def test_projection_pushup_examples_map_the_source():
    for name in ("Projection pushup", "Projection pushup over drop"):
        [code] = [code for example, _, code in SHIPPED if example == name]
        result = compile_plan(service.validate_request({"code": code}))
        [plan] = [plan for plan in result["plans"] if plan["name"] == "relational_rewrite"]
        assert [label.split("(")[0] for label in (n["label"] for n in plan["nodes"])] == [
            "Source", "Map", "Projection"]


@pytest.mark.parametrize("payload", [None, {"code": ""}, {"code": "x", "target": "x.y"},
    {"code": "x", "selector": "fastest"},
    {"code": "x", "phase": "execute"}, {"code": "x", "options": {"unknown": True}},
    {"code": "x", "options": {"cse": 1}}, {"code": "x", "resolve_variables": "yes"}])
def test_bad_requests_rejected(payload):
    with pytest.raises(ValueError):
        service.validate_request(payload)


def test_timeout_reaps_worker_and_next_submission_is_independent(monkeypatch):
    original = service.subprocess.Popen
    processes = []

    def spawn(*args, **kwargs):
        process = original(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(service.subprocess, "Popen", spawn)
    request = service.validate_request({"code": "while True: pass"})
    result = service.run_submission(request, timeout=.05)
    assert result["error"]["type"] == "Timeout"
    assert processes[0].poll() is not None
    with pytest.raises(ProcessLookupError):
        os.kill(processes[0].pid, 0)
    result = service.run_submission(service.validate_request({"code": "import skrub\nprint('ready')\ndag = skrub.as_data_op(1)"}))
    assert result["status"] == "completed", result
    assert result["stdout"] == "ready\n"


def test_process_exit_and_excess_output_have_bounded_results():
    crash = service.run_submission(service.validate_request({"code": "import os\nos._exit(9)"}))
    assert crash["status"] == "failed"
    assert crash["error"]["type"] == "WorkerError"
    output = service.run_submission(service.validate_request({"code": "import skrub\nprint('x' * 20000)\ndag = skrub.as_data_op(1)"}))
    assert output["status"] == "completed"
    assert len(output["stdout"]) < 16100
    assert "truncated" in output["stdout"]


def test_service_shutdown_cancels_inflight_submission():
    stopping = threading.Event()
    stopping.set()
    result = service.run_submission(service.validate_request({"code": "while True: pass"}), stopping=stopping)
    assert result["error"]["type"] == "Cancelled"


def test_warm_workers_plan_examples_and_isolate_submissions():
    with service.warm_workers() as context:
        for code in EXAMPLES:
            for phase in ("logical", "physical"):
                result = service.run_submission(service.validate_request({
                    "code": code, "phase": phase,
                }), worker_context=context)
                assert result["status"] == "completed", result
                assert result["plans"][0]["name"] == "skrub"
        changed = service.run_submission(service.validate_request({"code":
            "import stratum, skrub\nstratum._playground_leaked = True\n"
            "print('ready')\ndag = skrub.as_data_op(1)"
        }), worker_context=context)
        assert changed["status"] == "completed", changed
        assert changed["stdout"] == "ready\n"
        timed_out = service.run_submission(service.validate_request({"code":
            "while True: pass"
        }), timeout=.2, worker_context=context)
        assert timed_out["error"]["type"] == "Timeout"
        stopping = threading.Event()
        stopping.set()
        cancelled = service.run_submission(service.validate_request({"code":
            "while True: pass"
        }), stopping=stopping, worker_context=context)
        assert cancelled["error"]["type"] == "Cancelled"
        independent = service.run_submission(service.validate_request({"code":
            "import stratum, skrub\nassert not hasattr(stratum, '_playground_leaked')\n"
            "dag = skrub.as_data_op(1)"
        }), worker_context=context)
        assert independent["status"] == "completed", independent
