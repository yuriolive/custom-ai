"""
Offline tests for supervisor.py. No Modal token, no GPU, no spend, no real 600 seconds.

    cd tools/modal && uv run --locked python -m unittest test_supervisor -v

The three cases the issue names are the three this suite exists to hold down:

  * an early exit is detected within a poll of the exit, NOT at timeout_s;
  * a slow-but-alive load is still granted the whole window;
  * an exit after readiness takes the container down.

The clock and the sleep are injected, so "the full 600 s window" is asserted exactly
and costs nothing. `SupervisedServer` also takes its process as a plain object, so most
of this runs against a fake — but the tee, the pipes and the pump thread are proved
against real `subprocess` children at the bottom of the file, because a ring buffer that
works only against a fake pipe would be worth nothing.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import supervisor
from supervisor import (
    HEALTHY,
    LOADING,
    PERMANENT,
    TRANSIENT,
    UNBOUND,
    UNKNOWN,
    HealthProbe,
    LlamaServerExited,
    OutputTail,
    PermanentLoadFailure,
    ServerExit,
    SupervisedServer,
    classify_exit,
)

# The real thing, verbatim from the container log in issue #36. If the classifier stops
# recognising this exact text, the bug is back.
CUDA_OOM_LOG = [
    "[serve] ctx_size(per slot)=8192 parallel=91 total_ctx=745472",
    "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 46592.00 MiB on device 0:"
    " cudaMalloc failed: out of memory",
    "llama_init_from_model: failed to initialize the context:"
    " failed to allocate buffer for kv cache",
    "srv  llama_server: exiting due to model loading error",
]


class FakeClock:
    """A clock that only moves when something sleeps."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class FakeProc:
    """
    Enough of `subprocess.Popen` for the poll loop: alive for `alive_polls` calls to
    poll(), dead thereafter.
    """

    def __init__(self, *, alive_polls: int = 10**9, returncode: int = 1) -> None:
        self.alive_polls = alive_polls
        self._returncode = returncode
        self.polls = 0
        self.terminated = False
        self.killed = False
        self._exited = threading.Event()
        self.stdout = None

    def poll(self) -> int | None:
        self.polls += 1
        if self.polls > self.alive_polls:
            self._exited.set()
            return self._returncode
        return None

    def wait(self, timeout: float | None = None) -> int:
        if not self._exited.wait(timeout if timeout is not None else 5.0):
            raise subprocess.TimeoutExpired("fake", timeout or 5.0)
        return self._returncode

    def die(self) -> None:
        self.alive_polls = 0
        self._exited.set()

    def terminate(self) -> None:
        self.terminated = True
        self.die()

    def kill(self) -> None:
        self.killed = True
        self.die()


def build_server(
    proc: FakeProc, clock: FakeClock, *, tail_lines: list[str] | None = None
) -> SupervisedServer:
    tail = OutputTail()
    if tail_lines:
        tail.feed("\n".join(tail_lines) + "\n")
    return SupervisedServer(proc=proc, tail=tail, started_at=clock(), clock=clock)


# ═════════════════════════════════════════════════════════════════════════════
# 1. Early exit is detected at the exit, not at the timeout
# ═════════════════════════════════════════════════════════════════════════════


class EarlyExitTest(unittest.TestCase):
    def test_exit_during_load_aborts_within_one_poll(self):
        clock = FakeClock()
        proc = FakeProc(alive_polls=3, returncode=1)
        server = build_server(proc, clock, tail_lines=CUDA_OOM_LOG)
        probes = []

        with self.assertRaises(LlamaServerExited) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                timeout_s=600,
                probe=lambda: probes.append(1) or HealthProbe(UNBOUND, "refused"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )

        # The whole point: three probes and four seconds, not six hundred.
        self.assertEqual(len(probes), 3)
        self.assertEqual(clock.now, 3.0)
        report = caught.exception.report
        self.assertEqual(report.returncode, 1)
        self.assertLess(report.elapsed_s, 10.0)

    def test_error_names_the_exit_code_and_carries_the_tail(self):
        clock = FakeClock()
        server = build_server(FakeProc(alive_polls=0), clock, tail_lines=CUDA_OOM_LOG)

        with self.assertRaises(LlamaServerExited) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                probe=lambda: HealthProbe(UNBOUND, "refused"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )

        message = str(caught.exception)
        self.assertIn("rc=1", message)
        self.assertIn("cudaMalloc failed: out of memory", message)
        self.assertIn("exiting due to model loading error", message)
        self.assertEqual(caught.exception.report.failure.kind, PERMANENT)

    def test_death_is_checked_before_the_probe_is_even_attempted(self):
        # A process already gone when @enter reaches the loop must not cost a single
        # health probe — a probe against a dead port is a 5 s timeout for nothing.
        clock = FakeClock()
        server = build_server(FakeProc(alive_polls=0), clock, tail_lines=CUDA_OOM_LOG)
        probes = []

        with self.assertRaises(LlamaServerExited):
            supervisor.wait_until_ready(
                server,
                port=8080,
                probe=lambda: probes.append(1) or HealthProbe(UNBOUND, "refused"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )
        self.assertEqual(probes, [])


# ═════════════════════════════════════════════════════════════════════════════
# 2. A slow-but-alive load still gets the whole window
# ═════════════════════════════════════════════════════════════════════════════


class SlowLoadTest(unittest.TestCase):
    def test_alive_and_loading_is_granted_the_full_timeout(self):
        clock = FakeClock()
        proc = FakeProc()  # never dies
        server = build_server(proc, clock, tail_lines=["loading model ..."])
        probes = []

        with self.assertRaises(RuntimeError) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                timeout_s=600,
                probe=lambda: probes.append(1) or HealthProbe(LOADING, "HTTP 503"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )

        self.assertNotIsInstance(caught.exception, LlamaServerExited)
        self.assertEqual(clock.now, 600.0)
        self.assertEqual(len(probes), 601)
        message = str(caught.exception)
        self.assertIn("within 600s", message)
        # The message must say WHICH kind of stuck. `except OSError: pass` could not.
        self.assertIn("bound and answering, still loading", message)

    def test_healthy_just_before_the_ceiling_still_succeeds(self):
        clock = FakeClock()
        server = build_server(FakeProc(), clock)
        calls = []

        def probe():
            calls.append(1)
            return (
                HealthProbe(HEALTHY, "HTTP 200")
                if len(calls) >= 590
                else HealthProbe(LOADING, "HTTP 503")
            )

        elapsed = supervisor.wait_until_ready(
            server,
            port=8080,
            timeout_s=600,
            probe=probe,
            sleep=clock.sleep,
            clock=clock,
            echo=lambda _msg: None,
        )
        self.assertEqual(elapsed, 589.0)
        self.assertIsNotNone(server.ready_at)

    def test_a_death_inside_the_final_probe_window_is_still_a_death(self):
        # The nastiest boundary. If the child dies just before the ceiling is reached,
        # the loop breaks on the timeout — and the old shape would then report a corpse
        # as "still running" AND leave via RuntimeError, so _bring_up would never record
        # the failure the next cold start needs.
        clock = FakeClock()
        proc = FakeProc(alive_polls=5, returncode=1)
        server = build_server(proc, clock, tail_lines=CUDA_OOM_LOG)

        with self.assertRaises(LlamaServerExited) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                timeout_s=5,
                probe=lambda: HealthProbe(LOADING, "HTTP 503"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )
        self.assertEqual(caught.exception.report.returncode, 1)
        self.assertEqual(caught.exception.report.failure.code, "kv_cache_oom")

    def test_never_bound_reads_differently_from_still_loading(self):
        clock = FakeClock()
        server = build_server(FakeProc(), clock)
        with self.assertRaises(RuntimeError) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                timeout_s=5,
                probe=lambda: HealthProbe(UNBOUND, "ConnectionRefusedError"),
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )
        self.assertIn("never bound", str(caught.exception))

    def test_bound_then_refused_is_its_own_message(self):
        clock = FakeClock()
        server = build_server(FakeProc(), clock)
        calls = []

        def probe():
            calls.append(1)
            return (
                HealthProbe(LOADING, "HTTP 503")
                if len(calls) == 1
                else HealthProbe(UNBOUND, "ConnectionRefusedError")
            )

        with self.assertRaises(RuntimeError) as caught:
            supervisor.wait_until_ready(
                server,
                port=8080,
                timeout_s=5,
                probe=probe,
                sleep=clock.sleep,
                clock=clock,
                echo=lambda _msg: None,
            )
        self.assertIn("stopped accepting connections", str(caught.exception))


class StuckDescriptionTest(unittest.TestCase):
    def test_the_three_kinds_of_stuck_are_distinct(self):
        cases = {
            (LOADING, False): "bound and answering, still loading",
            (LOADING, True): "bound and answering, still loading",
            (UNBOUND, True): "bound earlier, then stopped accepting connections",
            (UNBOUND, False): "never bound",
        }
        for (state, ever_bound), expected in cases.items():
            with self.subTest(state=state, ever_bound=ever_bound):
                probe = HealthProbe(state, "detail")
                self.assertEqual(supervisor._stuck_description(probe, ever_bound), expected)


# ═════════════════════════════════════════════════════════════════════════════
# 3. An exit after readiness takes the container down
# ═════════════════════════════════════════════════════════════════════════════


class PostReadyWatchdogTest(unittest.TestCase):
    def test_exit_after_ready_kills_the_container(self):
        clock = FakeClock()
        proc = FakeProc(alive_polls=10**9, returncode=137)
        server = build_server(proc, clock, tail_lines=["CUDA error: out of memory"])
        server.ready_at = 12.0
        killed: list[ServerExit] = []
        noted: list[ServerExit] = []

        thread = supervisor.watch_after_ready(server, on_death=noted.append, kill=killed.append)
        proc.die()
        thread.join(5.0)

        self.assertFalse(thread.is_alive())
        self.assertEqual(len(killed), 1)
        self.assertEqual(len(noted), 1)
        self.assertTrue(killed[0].after_ready)
        self.assertEqual(killed[0].returncode, 137)

    def test_the_container_goes_down_even_if_reporting_the_death_throws(self):
        # on_death writes a file and commits a Volume. A watchdog that dies while
        # reporting leaves exactly the orphaned GPU it exists to prevent.
        clock = FakeClock()
        proc = FakeProc(alive_polls=10**9)
        server = build_server(proc, clock, tail_lines=["CUDA error: out of memory"])
        server.ready_at = 1.0
        killed = []

        def explode(_report):
            raise RuntimeError("the volume is on fire")

        # The traceback is deliberate diagnostics in production (where `kill` is
        # os._exit and never returns, so it is never actually reached). Silence it here
        # so a passing run does not look like a failing one.
        original_hook = threading.excepthook
        threading.excepthook = lambda _args: None
        self.addCleanup(lambda: setattr(threading, "excepthook", original_hook))

        thread = supervisor.watch_after_ready(server, on_death=explode, kill=killed.append)
        proc.die()
        thread.join(5.0)

        self.assertFalse(thread.is_alive())
        self.assertEqual(len(killed), 1)

    def test_shutdown_from_modal_exit_does_not_look_like_a_death(self):
        # Every ordinary scaledown terminates the child. If the watchdog treated that as
        # a crash, each one would end in os._exit(70) and read as a failure.
        clock = FakeClock()
        proc = FakeProc(alive_polls=10**9)
        server = build_server(proc, clock)
        server.ready_at = 1.0
        killed = []

        thread = supervisor.watch_after_ready(server, kill=killed.append)
        server.shutdown(timeout_s=1.0)
        thread.join(5.0)

        self.assertTrue(proc.terminated)
        self.assertEqual(killed, [])

    def test_shutdown_is_a_no_op_on_an_already_dead_child(self):
        clock = FakeClock()
        proc = FakeProc(alive_polls=0)
        server = build_server(proc, clock)
        server.shutdown()
        self.assertFalse(proc.terminated)
        self.assertFalse(proc.killed)

    def test_a_post_ready_death_is_never_cached_as_permanent(self):
        # A server that reached HEALTHY has PROVED this tuple loads. Caching a later
        # death would take a working model out of service over one bad request.
        report = ServerExit(
            returncode=1,
            elapsed_s=400.0,
            failure=classify_exit(CUDA_OOM_LOG, 1),
            tail=CUDA_OOM_LOG,
            after_ready=True,
        )
        self.assertTrue(report.failure.permanent)
        with tempfile.TemporaryDirectory() as tmp:
            written = supervisor.record_permanent_failure(tmp, "k", report)
            self.assertIsNone(written)
            self.assertIsNone(supervisor.lookup_permanent_failure(tmp, "k"))


# ═════════════════════════════════════════════════════════════════════════════
# Classification
# ═════════════════════════════════════════════════════════════════════════════


class ClassifyTest(unittest.TestCase):
    def test_the_observed_cuda_oom_is_permanent(self):
        failure = classify_exit(CUDA_OOM_LOG, 1)
        self.assertEqual(failure.kind, PERMANENT)
        self.assertEqual(failure.code, "kv_cache_oom")
        self.assertIn("KV cache", failure.hint)

    def test_plain_cuda_oom_without_a_kv_line(self):
        failure = classify_exit(["cudaMalloc failed: out of memory"], 1)
        self.assertEqual((failure.kind, failure.code), (PERMANENT, "cuda_oom"))

    def test_unsupported_architecture_is_permanent(self):
        failure = classify_exit(
            ["llama_model_load: error loading model: unknown model architecture: 'plamo3'"], 1
        )
        self.assertEqual((failure.kind, failure.code), (PERMANENT, "unsupported_arch"))

    def test_bad_gguf_is_permanent(self):
        failure = classify_exit(
            [
                "llama_model_loader: failed to load model from /cache/x.gguf: invalid magic character"
            ],
            1,
        )
        self.assertEqual(failure.kind, PERMANENT)
        self.assertIn(failure.code, {"bad_gguf", "unsupported_arch"})

    def test_download_trouble_is_transient(self):
        failure = classify_exit(
            ["huggingface_hub ... ConnectionError: HTTPSConnectionPool read timed out"], 1
        )
        self.assertEqual((failure.kind, failure.code), (TRANSIENT, "weights_download"))

    def test_volume_trouble_is_transient(self):
        failure = classify_exit(["OSError: [Errno 116] Stale file handle"], 1)
        self.assertEqual((failure.kind, failure.code), (TRANSIENT, "volume_io"))

    def test_silence_is_unknown_not_permanent(self):
        failure = classify_exit([], 1)
        self.assertEqual(failure.kind, UNKNOWN)
        self.assertFalse(failure.permanent)

    def test_sigkill_is_unknown_because_the_oom_killer_is_not_the_gpu(self):
        failure = classify_exit([], -9)
        self.assertEqual(failure.kind, UNKNOWN)
        self.assertEqual(failure.code, "signal_9")
        self.assertIn("OOM-killer", failure.hint)

    def test_the_most_specific_rule_wins(self):
        # Both patterns are present in the real log; the KV one is the actionable one,
        # because the remedy is ctx_size/parallel and not "a bigger card" alone.
        self.assertEqual(classify_exit(CUDA_OOM_LOG, 1).code, "kv_cache_oom")


# ═════════════════════════════════════════════════════════════════════════════
# The tee — stream onward AND keep a bounded tail
# ═════════════════════════════════════════════════════════════════════════════


class OutputTailTest(unittest.TestCase):
    def test_chunks_that_split_mid_line_reassemble(self):
        tail = OutputTail()
        tail.feed("llama_model_load")
        tail.feed(": error loading")
        tail.feed(" model\n")
        self.assertEqual(tail.lines(), ["llama_model_load: error loading model"])

    def test_a_partial_final_line_is_still_reported(self):
        # The child can die mid-sentence, and that sentence is usually the reason.
        tail = OutputTail()
        tail.feed("done\nexiting due to model loading err")
        self.assertEqual(tail.lines(), ["done", "exiting due to model loading err"])

    def test_carriage_returns_become_lines(self):
        tail = OutputTail()
        tail.feed("load 10%\rload 50%\rload 99%\r")
        self.assertEqual(tail.lines(), ["load 10%", "load 50%", "load 99%"])

    def test_crlf_does_not_produce_blank_lines(self):
        tail = OutputTail()
        tail.feed("one\r\ntwo\r\n")
        self.assertEqual(tail.lines(), ["one", "two"])

    def test_the_buffer_is_bounded(self):
        tail = OutputTail(max_lines=5)
        tail.feed("".join(f"line {i}\n" for i in range(100)))
        lines = tail.lines()
        self.assertEqual(len(lines), 5)
        self.assertEqual(lines[-1], "line 99")

    def test_a_cr_only_progress_bar_cannot_grow_without_bound(self):
        tail = OutputTail(max_lines=3, max_line_chars=50)
        tail.feed("x" * 5000)
        self.assertTrue(all(len(line) <= 50 for line in tail.lines()))

    def test_pump_echoes_everything_and_keeps_the_tail(self):
        # "Tee, do not capture": the startup report has to reach the log intact, because
        # the KV cache size it prints is the only check on the solver's arithmetic.
        class Reader:
            def __init__(self, chunks):
                self.chunks = list(chunks)

            def read1(self, _n):
                return self.chunks.pop(0) if self.chunks else b""

        class Sink:
            def __init__(self):
                self.written = []

            def write(self, text):
                self.written.append(text)

            def flush(self):
                pass

        report = b"llama_kv_cache: KV self size = 1024.00 MiB\nsrv  main: listening\n"
        tail = OutputTail()
        sink = Sink()
        supervisor.pump(Reader([report]), tail, sink)

        self.assertEqual("".join(sink.written), report.decode())
        self.assertIn("llama_kv_cache: KV self size = 1024.00 MiB", tail.lines())


# ═════════════════════════════════════════════════════════════════════════════
# The health probe's three states — the conflation this issue is about
# ═════════════════════════════════════════════════════════════════════════════


class ProbeStateTest(unittest.TestCase):
    def _with_urlopen(self, fake):
        original = urllib.request.urlopen
        urllib.request.urlopen = fake
        self.addCleanup(lambda: setattr(urllib.request, "urlopen", original))

    def test_a_503_is_loading_not_a_dead_port(self):
        def fake(_url, timeout=None):
            raise urllib.error.HTTPError(_url, 503, "Loading model", {}, None)

        self._with_urlopen(fake)
        probe = supervisor.probe_health(8080)
        self.assertEqual(probe.state, LOADING)
        self.assertTrue(probe.bound)

    def test_a_refused_connection_is_unbound(self):
        def fake(_url, timeout=None):
            raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))

        self._with_urlopen(fake)
        probe = supervisor.probe_health(8080)
        self.assertEqual(probe.state, UNBOUND)
        self.assertFalse(probe.bound)

    def test_a_200_is_healthy(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        self._with_urlopen(lambda _url, timeout=None: Response())
        self.assertEqual(supervisor.probe_health(8080).state, HEALTHY)

    def test_both_failures_are_still_oserror_but_no_longer_the_same(self):
        # HTTPError and URLError are both OSError subclasses, which is exactly why one
        # `except OSError: pass` could swallow "loading" and "long dead" identically.
        self.assertTrue(issubclass(urllib.error.HTTPError, OSError))
        self.assertTrue(issubclass(urllib.error.URLError, OSError))


# ═════════════════════════════════════════════════════════════════════════════
# Do not pay to fail twice
# ═════════════════════════════════════════════════════════════════════════════


def load_report(lines=None, rc=1, after_ready=False) -> ServerExit:
    lines = lines if lines is not None else CUDA_OOM_LOG
    return ServerExit(
        returncode=rc,
        elapsed_s=9.9,
        failure=classify_exit(lines, rc),
        tail=lines,
        after_ready=after_ready,
    )


class FailureCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "load-failures"
        self.params = {
            "gpu": "L4",
            "image": "ghcr.io/ggml-org/llama.cpp:server-cuda",
            "model_repo": "acme/model-GGUF",
            "model_file": "model-Q4_K_M.gguf",
            "ctx_size": 8192,
            "parallel": 91,
        }
        self.key = supervisor.failure_key(**self.params)

    def test_a_permanent_load_failure_is_recorded_and_found(self):
        path = supervisor.record_permanent_failure(
            self.dir,
            self.key,
            load_report(),
            params=self.params,
            now=lambda: "2026-08-20T03:00:00Z",
        )
        self.assertIsNotNone(path)
        record = supervisor.lookup_permanent_failure(self.dir, self.key)
        self.assertEqual(record["kind"], PERMANENT)
        self.assertEqual(record["code"], "kv_cache_oom")
        self.assertEqual(record["params"]["parallel"], 91)
        self.assertEqual(record["recorded_at"], "2026-08-20T03:00:00Z")

    def test_a_transient_failure_is_not_recorded(self):
        report = load_report(["ConnectionError: read timed out"])
        self.assertEqual(report.failure.kind, TRANSIENT)
        self.assertIsNone(
            supervisor.record_permanent_failure(self.dir, self.key, report, params=self.params)
        )
        self.assertIsNone(supervisor.lookup_permanent_failure(self.dir, self.key))

    def test_an_unreadable_exit_is_not_recorded(self):
        report = load_report([])
        self.assertEqual(report.failure.kind, UNKNOWN)
        self.assertIsNone(
            supervisor.record_permanent_failure(self.dir, self.key, report, params=self.params)
        )

    def test_the_volume_is_committed_or_the_next_container_never_sees_it(self):
        commits = []
        supervisor.record_permanent_failure(
            self.dir, self.key, load_report(), params=self.params, commit=lambda: commits.append(1)
        )
        self.assertEqual(commits, [1])

    def test_a_failing_commit_does_not_mask_the_failure(self):
        def boom():
            raise RuntimeError("volume unreachable")

        noise = []
        path = supervisor.record_permanent_failure(
            self.dir, self.key, load_report(), params=self.params, commit=boom, echo=noise.append
        )
        self.assertIsNotNone(path)
        self.assertIn("volume unreachable", " ".join(noise))

    def test_the_key_is_per_gpu_because_every_tier_shares_one_volume(self):
        on_h100 = supervisor.failure_key(**{**self.params, "gpu": "H100"})
        self.assertNotEqual(self.key, on_h100)
        supervisor.record_permanent_failure(self.dir, self.key, load_report(), params=self.params)
        # A CUDA OOM on an L4 says nothing whatsoever about an H100.
        self.assertIsNone(supervisor.lookup_permanent_failure(self.dir, on_h100))

    def test_the_key_moves_with_every_pool_selecting_parameter(self):
        base = supervisor.failure_key(**self.params)
        for field, value in [
            ("image", "ghcr.io/ggml-org/llama.cpp:server-cuda-b1234"),
            ("model_repo", "other/repo-GGUF"),
            ("model_file", "model-Q8_0.gguf"),
            ("ctx_size", 4096),
            ("parallel", 1),
        ]:
            with self.subTest(field=field):
                self.assertNotEqual(base, supervisor.failure_key(**{**self.params, field: value}))

    def test_a_known_permanent_failure_refuses_before_anything_is_downloaded(self):
        supervisor.record_permanent_failure(self.dir, self.key, load_report(), params=self.params)
        with self.assertRaises(PermanentLoadFailure) as caught:
            supervisor.raise_if_known_permanent(self.dir, self.key, env={}, echo=lambda _m: None)
        self.assertEqual(caught.exception.record["code"], "kv_cache_oom")
        self.assertIn("kv cache", str(caught.exception).lower())

    def test_an_unknown_parameter_set_is_allowed_through(self):
        supervisor.raise_if_known_permanent(self.dir, "never-seen", env={}, echo=lambda _m: None)

    def test_the_operator_escape_hatch_bypasses_the_cache(self):
        supervisor.record_permanent_failure(self.dir, self.key, load_report(), params=self.params)
        supervisor.raise_if_known_permanent(
            self.dir,
            self.key,
            env={supervisor.IGNORE_CACHE_ENV: "1"},
            echo=lambda _m: None,
        )

    def test_a_corrupt_sentinel_is_not_grounds_for_refusing_a_model(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / f"{self.key}.json").write_text("{ this is not json")
        self.assertIsNone(supervisor.lookup_permanent_failure(self.dir, self.key))
        supervisor.raise_if_known_permanent(self.dir, self.key, env={}, echo=lambda _m: None)

    def test_no_partly_written_sentinel_is_ever_visible(self):
        supervisor.record_permanent_failure(self.dir, self.key, load_report(), params=self.params)
        leftovers = [p.name for p in self.dir.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])


class LogFailureTest(unittest.TestCase):
    def test_one_greppable_json_line_carries_the_reason(self):
        lines = []
        supervisor.log_failure(load_report(), echo=lines.append)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("[serve] LOAD-FAILURE {"))
        record = json.loads("{" + lines[0].split("{", 1)[1])
        self.assertEqual(record["kind"], PERMANENT)
        self.assertEqual(record["code"], "kv_cache_oom")
        self.assertEqual(record["returncode"], 1)
        # The full tail is already in the log via the tee; repeating fifty lines inside
        # the one greppable line would make it unreadable.
        self.assertLessEqual(len(record["tail"]), 3)


# ═════════════════════════════════════════════════════════════════════════════
# Against real subprocesses. A ring buffer that works only on a fake pipe is
# worth nothing, and neither is a poll loop that has never met a real Popen.
# ═════════════════════════════════════════════════════════════════════════════


class RealChildTest(unittest.TestCase):
    def test_a_child_that_dies_during_load_is_caught_with_its_own_words(self):
        script = (
            "import sys, time\n"
            "print('llama_kv_cache: KV self size = 46592.00 MiB')\n"
            "sys.stderr.write('ggml_backend_cuda_buffer_type_alloc_buffer: "
            "cudaMalloc failed: out of memory\\n')\n"
            "sys.stderr.write('llama_init_from_model: failed to initialize the context: "
            "failed to allocate buffer for kv cache\\n')\n"
            "sys.stdout.flush(); sys.stderr.flush()\n"
            "sys.exit(1)\n"
        )
        echoed = []

        class Sink:
            def write(self, text):
                echoed.append(text)

            def flush(self):
                pass

        server = supervisor.launch([sys.executable, "-c", script], echo=Sink())
        self.addCleanup(server.shutdown)
        with self.assertRaises(LlamaServerExited) as caught:
            supervisor.wait_until_ready(
                server,
                port=1,  # nothing is listening; the probe will refuse, the poll will win
                timeout_s=30,
                echo=lambda _m: None,
            )

        report = caught.exception.report
        self.assertEqual(report.returncode, 1)
        self.assertEqual(report.failure.code, "kv_cache_oom")
        self.assertTrue(report.failure.permanent)
        self.assertFalse(report.after_ready)
        # Tee, not capture: the startup report reached the log AND the error.
        self.assertIn("KV self size = 46592.00 MiB", "".join(echoed))
        self.assertTrue(any("KV self size = 46592.00 MiB" in line for line in report.tail))

    def test_a_real_child_that_dies_after_ready_triggers_the_watchdog(self):
        server = supervisor.launch(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            echo=type("S", (), {"write": lambda _s, _t: None, "flush": lambda _s: None})(),
        )
        self.addCleanup(server.shutdown)
        server.ready_at = time.monotonic()
        killed = []
        thread = supervisor.watch_after_ready(server, kill=killed.append)

        server.proc.kill()
        thread.join(10.0)

        self.assertFalse(thread.is_alive())
        self.assertEqual(len(killed), 1)
        self.assertTrue(killed[0].after_ready)
        self.assertLess(killed[0].returncode, 0)  # killed by a signal

    def test_a_real_healthy_child_is_detected_and_then_shut_down(self):
        server = supervisor.launch(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            echo=type("S", (), {"write": lambda _s, _t: None, "flush": lambda _s: None})(),
        )
        self.addCleanup(server.shutdown)
        calls = []

        def probe():
            calls.append(1)
            return (
                HealthProbe(HEALTHY, "HTTP 200")
                if len(calls) >= 2
                else HealthProbe(LOADING, "HTTP 503")
            )

        elapsed = supervisor.wait_until_ready(
            server, port=8080, timeout_s=30, probe=probe, echo=lambda _m: None
        )
        self.assertGreaterEqual(elapsed, 0.0)
        self.assertIsNotNone(server.ready_at)
        self.assertIsNone(server.poll())

        server.shutdown(timeout_s=5.0)
        self.assertIsNotNone(server.poll())


if __name__ == "__main__":
    unittest.main()
