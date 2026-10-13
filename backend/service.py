"""Request validation and disposable-worker lifecycle, using the standard library."""
from __future__ import annotations

from contextlib import contextmanager
import json
import keyword
import multiprocessing
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from time import perf_counter

MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
OPTIONS = {"cse", "unroll_choices", "dataframe_ops", "numeric_ops",
           "algebraic_rewrites", "semi_join_rewrite", "propagate_schema"}


def _ready():
    # Also verify that preload succeeded (forkserver ignores ImportError).
    import backend.worker  # noqa: F401


@contextmanager
def warm_workers():
    """Import once in a dedicated forkserver, never fork the threaded HTTP server."""
    names = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
             "POLARS_MAX_THREADS", "MPLCONFIGDIR")
    original = {name: os.environ.get(name) for name in names}
    with tempfile.TemporaryDirectory(prefix="stratum-playground-imports-") as cache:
        try:
            for name in names[:-1]:
                os.environ[name] = "2"
            os.environ.setdefault("MPLCONFIGDIR", cache)
            context = multiprocessing.get_context("forkserver")
            context.set_forkserver_preload(["backend.worker"])
            process = context.Process(target=_ready)
            process.start()
            process.join()
            if process.exitcode != 0:
                raise RuntimeError("Could not preload optimizer dependencies.")
            process.close()
            yield context
        finally:
            for name, value in original.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


def _run_warm_worker(request_path, result_path, stdout_path, stderr_path):
    os.setsid()
    os.chdir(Path(__file__).resolve().parents[1])
    with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
        os.dup2(stdout.fileno(), 1)
        os.dup2(stderr.fileno(), 2)
    from backend.worker import run_files
    run_files(request_path, result_path)


class _WarmWorker:
    """Match the small Popen interface used by submission cleanup."""

    def __init__(self, context, request_path, result_path, directory):
        self.args = [str(request_path)]
        self.process = context.Process(target=_run_warm_worker, args=(
            request_path, result_path, directory / "stdout.log", directory / "stderr.log"))
        self.process.start()
        self.pid = self.process.pid

    @property
    def returncode(self):
        return self.process.exitcode

    def wait(self, timeout=None):
        self.process.join(timeout)
        if self.process.exitcode is None:
            raise subprocess.TimeoutExpired(self.args, timeout)
        return self.process.exitcode


def validate_request(value):
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object.")
    code = value.get("code")
    if not isinstance(code, str) or not code.strip() or len(code.encode()) > MAX_REQUEST_BYTES:
        raise ValueError("Provide Python code, up to 64 KiB.")
    target = value.get("target", "dag")
    if not isinstance(target, str) or not target.isidentifier() or keyword.iskeyword(target):
        raise ValueError("The output variable must be a Python identifier.")
    phase = value.get("phase", "logical")
    if phase not in ("logical", "physical"):
        raise ValueError("Choose logical or physical optimization.")
    options = value.get("options", {})
    if not isinstance(options, dict) or not set(options) <= OPTIONS or any(type(v) is not bool for v in options.values()):
        raise ValueError("Optimizer options must be supported boolean switches.")
    selector = value.get("selector", "default")
    if selector not in ("default", "greedy"):
        raise ValueError("Choose the default or greedy implementation selector.")
    resolve = value.get("resolve_variables", True)
    if type(resolve) is not bool:
        raise ValueError("resolve_variables must be boolean.")
    return {"code": code, "target": target, "phase": phase, "selector": selector,
            "options": options, "resolve_variables": resolve}


def failed(kind, message):
    return {"status": "failed", "plans": [], "error": {
        "stage": "worker", "type": kind, "message": message, "traceback": ""},
        "timings": {"preparation": 0.0, "optimization": 0.0}}


def run_submission(request, timeout=30, stopping=None, worker_context=None):
    start = perf_counter()
    with tempfile.TemporaryDirectory(prefix="stratum-playground-") as temporary:
        directory = Path(temporary)
        request_path, result_path = directory / "request.json", directory / "result.json"
        request_path.write_text(json.dumps(request))
        environment = dict(os.environ, OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2",
                           MKL_NUM_THREADS="2", POLARS_MAX_THREADS="2")
        environment.setdefault("MPLCONFIGDIR", str(directory / "matplotlib"))
        with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
            if worker_context:
                process = _WarmWorker(worker_context, request_path, result_path, directory)
            else:
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("worker.py")), str(request_path), str(result_path)],
                    stdout=stdout, stderr=stderr, env=environment, start_new_session=True,
                    cwd=Path(__file__).resolve().parents[1])
            try:
                deadline = perf_counter() + timeout
                while True:
                    if stopping is not None and stopping.is_set():
                        raise InterruptedError("Backend is shutting down.")
                    remaining = deadline - perf_counter()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(process.args, timeout)
                    try:
                        process.wait(timeout=min(.2, remaining) if stopping is not None else remaining)
                        break
                    except subprocess.TimeoutExpired:
                        if perf_counter() >= deadline:
                            raise
            except InterruptedError:
                result = failed("Cancelled", "Backend shut down during submission.")
            except subprocess.TimeoutExpired:
                result = failed("Timeout", f"Submission exceeded the {timeout:g} second limit.")
            else:
                try:
                    if process.returncode or result_path.stat().st_size > MAX_RESPONSE_BYTES:
                        raise ValueError("Worker exited or its result exceeded the size limit.")
                    result = json.loads(result_path.read_text())
                except (OSError, ValueError):
                    result = failed("WorkerError", f"Worker could not return a plan (exit {process.returncode}).")
            finally:
                # Also reap children that submitted code may have started.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    # Cancellation can arrive before the warm child setsid().
                    if isinstance(process, _WarmWorker) and process.returncode is None:
                        process.process.kill()
                process.wait()
                if isinstance(process, _WarmWorker):
                    process.process.close()
        for name in ("stdout", "stderr"):
            with (directory / f"{name}.log").open("rb") as stream:
                data = stream.read(16001)
            result[name] = data[:16000].decode("utf-8", errors="replace")
            if len(data) > 16000:
                result[name] += "\n… output truncated"
        result["timings"]["total"] = perf_counter() - start
        return result
