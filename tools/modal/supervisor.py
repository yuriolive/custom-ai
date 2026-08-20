"""
supervisor.py — keep llama-server on a leash, and make its death end the container.

═══════════════════════════════════════════════════════════════════════════════
WHY THIS IS A SEPARATE MODULE FROM app.py

`app.py` imports `modal`, and `modal` is NOT installed on the path CI runs
(`pyproject.toml` declares no runtime dependencies precisely so the suite needs
nothing installed). Anything that lives in `app.py` is therefore untestable, and
every decision below is one you want a test for: when to abort the poll loop,
which failures are worth never retrying, what the error message actually says.

So this module is stdlib-only and holds the judgement; `app.py` stays wiring.
Because `modal deploy` no longer auto-mounts local Python modules, `app.py` has
to declare this one with `Image.add_local_python_source("supervisor")` — without
that line the container dies at import with `ModuleNotFoundError`.
═══════════════════════════════════════════════════════════════════════════════

THE BUG THIS EXISTS TO KILL

`subprocess.Popen(cmd)` with the handle dropped, plus a health poll that treated
every failure as "still loading", meant a container whose llama-server had already
exited sat against a dead port for the full 600 s window (or Modal's 900 s
`startup_timeout`) holding a GPU it could never serve from — and did it again on
the next request, because the failure is a property of the parameter set.

Observed live: CUDA OOM on a 46 GiB KV allocation, server gone 10 s in, no HEALTHY
line and no exception in the container log.

Three things fix it, and all three are here:

  1. `poll()` before every probe. `returncode is not None` is the cheapest and
     most exact death signal available, and it is already in hand.
  2. A tee, not a capture. llama.cpp's startup report carries the KV cache size it
     ACTUALLY allocated, which is the only ground truth against the solver's
     `kv_bytes_per_token` arithmetic — it must keep reaching the Modal log. So the
     output is echoed onward AND kept in a bounded ring buffer for the error.
  3. A classifier. A CUDA OOM for a given (gpu, model, ctx, parallel) tuple is
     deterministic: retrying it is a guaranteed repeat charge. Permanent failures
     leave a sentinel on the shared weights Volume so the NEXT cold start of that
     same tuple fails in container-boot time instead of download + load + poll.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

# ── Tunables ─────────────────────────────────────────────────────────────────
# The ceiling is unchanged from the original code and is still 600 s, because a
# large model legitimately takes minutes to load. What changed is that it is now
# only ever reached by a process that is STILL ALIVE — see wait_until_ready().
DEFAULT_READY_TIMEOUT_S = 600
POLL_INTERVAL_S = 1.0
HEALTH_PROBE_TIMEOUT_S = 5.0

# How much of the child's output to keep for the error message. Fifty lines is
# enough to carry llama.cpp's failure plus the allocation numbers above it, and
# small enough that it cannot itself become the problem.
LOG_TAIL_LINES = 50
# llama.cpp draws load progress with bare carriage returns. Without a cap, a
# progress bar that never emits '\n' would grow one "line" without bound.
LOG_TAIL_LINE_CHARS = 2000

# Exit status the watchdog takes the container down with. Distinct from 1 so the
# reason is visible in Modal's container list rather than looking like a crash on
# our own code.
EXIT_CODE_SERVER_DIED = 70

# Where the "do not pay to fail twice" sentinels live, under the same Modal Volume
# that already holds the weight cache. One directory, one file per parameter set.
FAILURE_CACHE_DIRNAME = "load-failures"

# Operator escape hatch. A sentinel is a claim about hardware and a GGUF, and both
# can be wrong (a repinned llama.cpp image, a re-uploaded file). Set this to bypass
# the cache for one cold start without having to reach into the Volume.
IGNORE_CACHE_ENV = "NEXUS_IGNORE_LOAD_FAILURE_CACHE"

# ── Failure kinds ────────────────────────────────────────────────────────────
# PERMANENT is the only one that writes a sentinel. UNKNOWN deliberately does not:
# refusing to serve a model because of an exit we could not read would be a worse
# failure than the repeat charge it saves.
PERMANENT = "permanent"
TRANSIENT = "transient"
UNKNOWN = "unknown"

# ── Health probe states ──────────────────────────────────────────────────────
# The whole point of naming these. `except OSError: pass` covered LOADING and
# UNBOUND with one clause, which is why "the model is still loading" and "the
# process exited ten seconds ago" were indistinguishable.
HEALTHY = "healthy"  # 200 — llama-server says it can serve
LOADING = "loading"  # bound and answering, non-200 (503 {"message":"Loading model"})
UNBOUND = "unbound"  # nothing accepting connections on the port


@dataclass(frozen=True)
class HealthProbe:
    state: str
    detail: str

    @property
    def bound(self) -> bool:
        return self.state != UNBOUND


@dataclass(frozen=True)
class LoadFailure:
    """Why llama-server exited, and whether trying again could ever help."""

    kind: str  # PERMANENT | TRANSIENT | UNKNOWN
    code: str  # stable slug, safe to branch on
    hint: str  # plain language, creator-facing (FR-STU-008 shape)

    @property
    def permanent(self) -> bool:
        return self.kind == PERMANENT


@dataclass(frozen=True)
class ServerExit:
    """Everything known about a dead llama-server, assembled once."""

    returncode: int
    elapsed_s: float
    failure: LoadFailure
    tail: list[str]
    after_ready: bool = False

    def summary(self) -> str:
        return (
            f"llama-server exited rc={self.returncode} after {self.elapsed_s:.1f}s "
            f"({self.failure.kind}/{self.failure.code})"
        )

    def as_dict(self) -> dict:
        return {
            "returncode": self.returncode,
            "elapsed_s": round(self.elapsed_s, 3),
            "kind": self.failure.kind,
            "code": self.failure.code,
            "hint": self.failure.hint,
            "after_ready": self.after_ready,
            "tail": self.tail,
        }


class LlamaServerExited(RuntimeError):
    """
    Raised from `@modal.enter` when the child is already gone.

    A raise in `@modal.enter` is what tells Modal to tear the container down, so
    reaching it in ~10 s instead of ~600 s IS the saving this module exists for.
    """

    def __init__(self, report: ServerExit) -> None:
        tail = "\n".join(report.tail)
        super().__init__(f"{report.summary()}: {report.failure.hint}\n--- last output ---\n{tail}")
        self.report = report


class PermanentLoadFailure(RuntimeError):
    """
    Raised INSTEAD of starting anything, when a sentinel says this exact parameter
    set has already proved unloadable on this exact GPU. Costs container boot, not
    a weight download and a model load.
    """

    def __init__(self, record: dict) -> None:
        super().__init__(
            f"llama-server previously failed to load this parameter set "
            f"({record.get('code')}): {record.get('hint')} "
            f"[recorded {record.get('recorded_at')}; "
            f"set {IGNORE_CACHE_ENV}=1 to retry anyway]"
        )
        self.record = record


# ═════════════════════════════════════════════════════════════════════════════
# Classification
#
# Ordered most-specific-first and matched against the tail as one blob. These are
# llama.cpp's and huggingface_hub's own strings; they are matched loosely on
# purpose, because the surrounding text moves between builds and the substrings do
# not. A pattern that stops matching degrades to UNKNOWN, which is the safe side:
# UNKNOWN never writes a sentinel, so a stale pattern costs a repeated cold start,
# never a model wrongly refused.
# ═════════════════════════════════════════════════════════════════════════════

_RULES: tuple[tuple[str, str, str, str], ...] = (
    # (regex, kind, code, hint)
    (
        r"failed to allocate buffer for kv cache|failed to initialize the context",
        PERMANENT,
        "kv_cache_oom",
        "The KV cache did not fit in VRAM. llama.cpp allocates ctx_size * parallel "
        "tokens of cache at once, so lower the context length, lower the concurrent "
        "stream count, or place this model on a card with more VRAM.",
    ),
    (
        r"cudaMalloc failed: out of memory|CUDA error: out of memory|"
        + r"ggml_backend_cuda_buffer_type_alloc_buffer",
        PERMANENT,
        "cuda_oom",
        "The GPU ran out of memory while loading. The weights plus the KV cache for "
        "ctx_size * parallel tokens exceed this card's VRAM — reduce context or "
        "concurrency, or choose a larger card.",
    ),
    (
        r"unknown model architecture|unsupported model architecture|"
        + r"unknown architecture|unsupported architecture",
        PERMANENT,
        "unsupported_arch",
        "This model's architecture is not supported by the pinned llama.cpp build. "
        "A newer build may add it; nothing about the deployment settings will.",
    ),
    (
        r"invalid magic character|gguf_init_from_file failed|"
        + r"failed to load model|unable to load model|"
        + r"wrong number of tensors|tensor .* not found|invalid model file",
        PERMANENT,
        "bad_gguf",
        "The GGUF file could not be read as a model. It may be truncated, may not be "
        "a servable model file (a draft or mmproj file is not), or may need a newer "
        "llama.cpp build.",
    ),
    (
        r"error while handling model file|unsupported quantization|"
        + r"quantization type not supported",
        PERMANENT,
        "unsupported_quant",
        "The pinned llama.cpp build cannot read this file's quantization. Pick a more "
        "common quant of the same model.",
    ),
    (
        r"ConnectionError|ConnectionResetError|IncompleteRead|Read timed out|"
        + r"ReadTimeout|Temporary failure in name resolution|"
        + r"HTTP Error 5\d\d|429 Too Many Requests|hf_transfer|"
        + r"RepositoryNotFoundError|EntryNotFoundError|Consistency check failed",
        TRANSIENT,
        "weights_download",
        "Fetching the weights failed. This is usually the network or Hugging Face, "
        "not the model — the next cold start may well succeed.",
    ),
    (
        r"Stale file handle|Input/output error|No space left on device|"
        + r"Transport endpoint is not connected",
        TRANSIENT,
        "volume_io",
        "The weight cache volume misbehaved during load. Not a property of the model; "
        "retrying is reasonable.",
    ),
)

_COMPILED = tuple(
    (re.compile(pattern, re.IGNORECASE), kind, code, hint) for pattern, kind, code, hint in _RULES
)

_UNKNOWN_EXIT = LoadFailure(
    UNKNOWN,
    "unclassified",
    "llama-server exited without output this module recognises. Read the container "
    "log; the failure is not being cached, so the next request will try again.",
)


def classify_exit(lines: list[str] | tuple[str, ...], returncode: int | None = None) -> LoadFailure:
    """
    Read a dead server's last output and decide whether retrying could ever help.

    `returncode` is only consulted when the output says nothing: a negative code
    means a signal, and a signal leaves no message of its own. Notably SIGKILL is
    NOT treated as permanent — it is most often the host OOM-killer, which the next
    container may well survive.
    """
    blob = "\n".join(lines)
    for pattern, kind, code, hint in _COMPILED:
        if pattern.search(blob):
            return LoadFailure(kind, code, hint)

    if returncode is not None and returncode < 0:
        signal_number = -returncode
        return LoadFailure(
            UNKNOWN,
            f"signal_{signal_number}",
            f"llama-server was killed by signal {signal_number} with nothing in its "
            "output to explain it — most often the host OOM-killer rather than the GPU. "
            "Not cached as permanent, because a different container may survive it.",
        )
    return _UNKNOWN_EXIT


# ═════════════════════════════════════════════════════════════════════════════
# Output tee
# ═════════════════════════════════════════════════════════════════════════════


class OutputTail:
    """
    A bounded ring buffer of the child's most recent output lines.

    This is the "tee, do not capture" half. The pump writes every byte onward to
    the Modal log — llama.cpp's startup report, KV cache size and all — and feeds
    the same bytes here so the raised error can name the reason. Capturing instead
    would trade the one measurement that validates the solver for an error message.
    """

    def __init__(
        self,
        max_lines: int = LOG_TAIL_LINES,
        max_line_chars: int = LOG_TAIL_LINE_CHARS,
    ) -> None:
        self._lines: deque[str] = deque(maxlen=max_lines)
        self._pending = ""
        self._max_line_chars = max_line_chars
        self._lock = threading.Lock()

    def feed(self, text: str) -> None:
        """Absorb an arbitrary chunk — not necessarily whole lines."""
        if not text:
            return
        with self._lock:
            # Normalise both terminators, and in this order: llama.cpp draws its load
            # progress with bare CRs, and '\r\n' must not become an empty line between
            # two real ones.
            merged = (self._pending + text).replace("\r\n", "\n").replace("\r", "\n")
            *complete, tail = merged.split("\n")
            for raw in complete:
                stripped = raw.strip()
                if stripped:
                    self._lines.append(stripped)
            if len(tail) > self._max_line_chars:
                # A CR-only progress bar never terminates a line. Flush it rather than
                # let one "line" grow without bound.
                self._lines.append(tail[-self._max_line_chars :].strip())
                tail = ""
            self._pending = tail

    def lines(self) -> list[str]:
        """Complete lines, plus whatever partial line the child died mid-way through."""
        with self._lock:
            out = list(self._lines)
            leftover = self._pending.strip()
            limit = self._lines.maxlen or len(out) + 1
        if leftover:
            out.append(leftover)
        return out[-limit:]

    def text(self) -> str:
        return "\n".join(self.lines())


def pump(reader, tail: OutputTail, echo: TextIO) -> None:
    """
    Drain the child's merged stdout/stderr until EOF, echoing as it goes.

    `read1` rather than `read`: `read` blocks until it has the full request or EOF,
    which would hold llama.cpp's startup report hostage until the process died —
    exactly the log line we most need while it is still loading.
    """
    while True:
        try:
            chunk = reader.read1(65536)
        except (OSError, ValueError):
            # ValueError: the pipe was closed underneath us during teardown.
            break
        if not chunk:
            break
        text = chunk.decode("utf-8", errors="replace")
        tail.feed(text)
        try:
            echo.write(text)
            echo.flush()
        except (OSError, ValueError):
            break


# ═════════════════════════════════════════════════════════════════════════════
# The supervised child
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class SupervisedServer:
    """
    A llama-server process plus the plumbing that notices it died.

    Constructed directly by the tests with a fake `proc`; every dependency that
    would otherwise reach the OS or the clock is a field, so the poll loop's
    behaviour is testable without a GPU, a port, or six hundred real seconds.
    """

    proc: object
    tail: OutputTail
    started_at: float
    clock: Callable[[], float] = time.monotonic
    pump_thread: threading.Thread | None = None
    ready_at: float | None = None
    # Set by shutdown() so the watchdog can tell "the server died" from "we killed
    # it on the way out". Without it every ordinary scaledown would end in
    # os._exit(70) and read as a crash in Modal's container list.
    stopping: bool = False
    _reported: ServerExit | None = field(default=None, init=False, repr=False)

    def poll(self) -> int | None:
        return self.proc.poll()

    def wait(self) -> int:
        return self.proc.wait()

    def uptime_s(self) -> float:
        return self.clock() - self.started_at

    def drain(self, timeout_s: float = 1.0) -> None:
        """
        Give the pump a moment to catch up before we quote the tail.

        Without this the error message routinely omits the very lines that explain
        the exit: the process is reaped before the pipe is drained, so the reason
        is still in flight when we go looking for it.
        """
        if self.pump_thread is not None and self.pump_thread.is_alive():
            self.pump_thread.join(timeout_s)

    def exit_report(self, *, drain_timeout_s: float = 1.0) -> ServerExit:
        """Assemble the report once; the watchdog and the enter path share it."""
        if self._reported is not None:
            return self._reported
        self.drain(drain_timeout_s)
        returncode = self.proc.poll()
        if returncode is None:
            returncode = -1
        lines = self.tail.lines()
        report = ServerExit(
            returncode=returncode,
            elapsed_s=self.uptime_s(),
            failure=classify_exit(lines, returncode),
            tail=lines,
            after_ready=self.ready_at is not None,
        )
        self._reported = report
        return report

    def shutdown(self, timeout_s: float = 10.0) -> None:
        """
        Stop the child on the way out, from `@modal.exit`.

        A container can be torn down for reasons that have nothing to do with the
        server — scaledown, a redeploy — and an orphaned llama-server holding the
        GPU while Modal believes the container is gone is the same bill this module
        exists to stop paying.
        """
        self.stopping = True
        try:
            if self.proc.poll() is None:
                try:
                    self.proc.terminate()
                    self.proc.wait(timeout_s)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                except (OSError, ValueError):
                    pass
        finally:
            self._close_pipe()

    def _close_pipe(self) -> None:
        stream = getattr(self.proc, "stdout", None)
        if stream is None:
            return
        self.drain(1.0)
        with contextlib.suppress(OSError, ValueError):
            stream.close()


def launch(
    cmd: list[str],
    *,
    echo: TextIO | None = None,
    popen: Callable[..., object] = subprocess.Popen,
    clock: Callable[[], float] = time.monotonic,
) -> SupervisedServer:
    """
    Start llama-server and keep the handle.

    stderr is merged into stdout deliberately: llama.cpp splits its startup report
    across both, and two pipes would interleave the KV cache numbers with the
    config that produced them in the wrong order in the Modal log.
    """
    sink = echo if echo is not None else sys.stdout
    started_at = clock()
    proc = popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = OutputTail()
    thread = threading.Thread(
        target=pump,
        args=(proc.stdout, tail, sink),
        name="llama-server-tee",
        daemon=True,
    )
    thread.start()
    return SupervisedServer(
        proc=proc, tail=tail, started_at=started_at, clock=clock, pump_thread=thread
    )


# ═════════════════════════════════════════════════════════════════════════════
# Readiness
# ═════════════════════════════════════════════════════════════════════════════


def probe_health(port: int, *, timeout_s: float = HEALTH_PROBE_TIMEOUT_S) -> HealthProbe:
    """
    One /health poll, reported as one of three states rather than as a bool.

    HTTPError is caught BEFORE URLError because it is a subclass of it, and the
    distinction is the whole point: an HTTP response — even a 503 — proves the
    server is bound and alive, which is exactly what a refused connection does not.
    """
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout_s) as r:
            if r.status == 200:
                return HealthProbe(HEALTHY, "HTTP 200")
            return HealthProbe(LOADING, f"HTTP {r.status}")
    except urllib.error.HTTPError as e:
        # llama-server binds the port immediately and answers
        # 503 {"error":{"message":"Loading model"}} for the whole load window.
        return HealthProbe(LOADING, f"HTTP {e.code}")
    except urllib.error.URLError as e:
        return HealthProbe(UNBOUND, f"{type(e.reason).__name__}: {e.reason}")
    except OSError as e:
        return HealthProbe(UNBOUND, f"{type(e).__name__}: {e}")


def _stuck_description(last: HealthProbe, ever_bound: bool) -> str:
    """Which kind of slow, for the timeout message. See wait_until_ready()."""
    if last.bound:
        return "bound and answering, still loading"
    if ever_bound:
        return "bound earlier, then stopped accepting connections"
    return "never bound"


def wait_until_ready(
    server: SupervisedServer,
    *,
    port: int,
    timeout_s: int = DEFAULT_READY_TIMEOUT_S,
    probe: Callable[[], HealthProbe] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    echo: Callable[[str], None] = print,
) -> float:
    """
    Block until llama-server reports itself HEALTHY, or until it dies trying.

    The health gate itself is load-bearing and was found the hard way:
    `@modal.web_server` marks a container ready as soon as the port ACCEPTS
    CONNECTIONS, but llama-server binds immediately and answers every request with
    `503 {"error":{"message":"Loading model"}}` for the whole load window. Without
    this wait, Modal routes the first (cold) request to a container that answers
    503 instead of streaming — the exact path the product depends on, failing on
    real users and on nobody's test.

    What is new is the FIRST statement of the loop. `proc.poll()` runs before every
    probe, so a server that exited nine seconds in raises here at t≈10s instead of
    at t=600s. The 600 s ceiling is kept, unchanged, for the case it was always for:
    a genuinely slow load by a process that is still running.
    """
    do_probe = probe if probe is not None else (lambda: probe_health(port))
    t0 = clock()
    attempt = 0
    ever_bound = False
    last = HealthProbe(UNBOUND, "not yet polled")

    while True:
        # Death before diagnosis. The returncode is exact and free; the probe is
        # neither, and every second spent on it is a GPU-second.
        if server.poll() is not None:
            raise LlamaServerExited(server.exit_report())

        attempt += 1
        last = do_probe()
        ever_bound = ever_bound or last.bound
        if last.state == HEALTHY:
            elapsed = clock() - t0
            server.ready_at = clock()
            echo(f"[serve] llama-server HEALTHY after {elapsed:.1f}s ({attempt} polls)")
            return elapsed

        if clock() - t0 >= timeout_s:
            break
        sleep(POLL_INTERVAL_S)

    # The ceiling was reached. One last poll before blaming a slow load: a process
    # that died inside the final probe window would otherwise be described as "still
    # running", and — worse — leave via RuntimeError instead of LlamaServerExited, so
    # the caller would never record the failure the next cold start needs.
    if server.poll() is not None:
        raise LlamaServerExited(server.exit_report())

    # Genuinely alive, just slow. Say WHICH kind of slow: bound-and-503 (loading, not
    # finished) versus never-bound (the port never came up). The old single
    # `except OSError: pass` could not tell those apart at all.
    raise RuntimeError(
        f"llama-server did not become healthy within {timeout_s}s "
        f"({attempt} polls, still running, {_stuck_description(last, ever_bound)}, "
        f"last probe: {last.detail})\n"
        f"--- last output ---\n{server.tail.text()}"
    )


# ═════════════════════════════════════════════════════════════════════════════
# Post-ready watchdog
# ═════════════════════════════════════════════════════════════════════════════


def hard_exit(report: ServerExit) -> None:
    """
    Take the container down, now.

    `os._exit` and not `sys.exit`: this runs on the watchdog thread, where
    SystemExit unwinds that thread alone and leaves Modal's runner alive, still
    advertising a port nothing is listening on. Killing the process is what makes
    Modal reap the container, and what turns an in-flight request's silent hang
    into a connection reset the gateway can report.
    """
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(OSError, ValueError):
            stream.flush()
    os._exit(EXIT_CODE_SERVER_DIED)


def watch_after_ready(
    server: SupervisedServer,
    *,
    on_death: Callable[[ServerExit], None] | None = None,
    kill: Callable[[ServerExit], None] = hard_exit,
) -> threading.Thread:
    """
    Watch a HEALTHY server for the rest of the container's life.

    Without this, a server that dies mid-life (CUDA OOM on a long prompt, the host
    OOM-killer) leaves `@modal.web_server` proxying to a closed port until
    `scaledown_window=30` of inactivity elapses. Callers get a connection error the
    gateway reads as an upstream fault, and the GPU stays on the clock the whole
    time. There is no state in which that container is worth more than nothing.
    """

    def _watch() -> None:
        server.wait()
        if server.stopping:
            # `@modal.exit` asked for this. The container is already going away.
            return
        report = server.exit_report()
        # try/finally, because on_death writes a file and commits a Volume. If any of
        # that throws, the container must STILL go down — a watchdog that dies while
        # reporting leaves exactly the orphan it exists to prevent.
        try:
            if on_death is not None:
                on_death(report)
        finally:
            kill(report)

    thread = threading.Thread(target=_watch, name="llama-server-watchdog", daemon=True)
    thread.start()
    return thread


# ═════════════════════════════════════════════════════════════════════════════
# Do not pay to fail twice
#
# A model-load failure is a property of the tuple (gpu, image, repo, file,
# ctx_size, parallel) — the same tuple that IS Modal's container-pool selector.
# Retrying it is not optimism, it is a guaranteed repeat charge at full price,
# multiplied by max_containers when several requests arrive together.
#
# The sentinel lives on the weights Volume because that is the only thing this
# container already has that outlives it. The GPU is part of the key and must be:
# every tier class mounts the SAME Volume, and a CUDA OOM on an L4 says nothing
# whatsoever about an H100.
# ═════════════════════════════════════════════════════════════════════════════


def failure_key(
    *,
    gpu: str,
    image: str,
    model_repo: str,
    model_file: str,
    ctx_size: int,
    parallel: int,
) -> str:
    canonical = json.dumps(
        {
            "gpu": gpu,
            "image": image,
            "model_repo": model_repo,
            "model_file": model_file,
            "ctx_size": ctx_size,
            "parallel": parallel,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def cache_disabled(env: dict[str, str] | None = None) -> bool:
    raw = (env if env is not None else os.environ).get(IGNORE_CACHE_ENV, "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def lookup_permanent_failure(cache_dir: str | Path, key: str) -> dict | None:
    """Return a previously recorded permanent failure for this key, or None."""
    path = Path(cache_dir) / f"{key}.json"
    try:
        record = json.loads(path.read_text())
    except (OSError, ValueError):
        # A missing sentinel and an unreadable one mean the same thing here: we do
        # not know that this will fail, so we are not entitled to refuse it.
        return None
    if not isinstance(record, dict) or record.get("kind") != PERMANENT:
        return None
    return record


def record_permanent_failure(
    cache_dir: str | Path,
    key: str,
    report: ServerExit,
    *,
    params: dict | None = None,
    commit: Callable[[], None] | None = None,
    now: Callable[[], str] | None = None,
    echo: Callable[[str], None] = print,
) -> Path | None:
    """
    Persist a permanent failure so the next cold start of this tuple is free.

    Only PERMANENT is written, and only for a death DURING LOAD. TRANSIENT and
    UNKNOWN return None because refusing to serve a model over an exit we could not
    read costs more than the repeat charge it saves; `after_ready` returns None for
    a stronger reason — a server that reached HEALTHY has proved this tuple loads,
    so the death was about one request (a CUDA OOM on a long prompt, the host
    OOM-killer) and caching it would take a working model out of service.

    `commit` is `modal.Volume.commit` when called from the worker. It matters: this
    process is about to `os._exit`, and a Volume write that is never committed is
    invisible to the very next container — the one whose bill this is meant to
    stop.
    """
    if not report.failure.permanent or report.after_ready:
        return None
    stamp = now() if now is not None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "kind": report.failure.kind,
        "code": report.failure.code,
        "hint": report.failure.hint,
        "returncode": report.returncode,
        "elapsed_s": round(report.elapsed_s, 3),
        "after_ready": report.after_ready,
        "recorded_at": stamp,
        "params": params or {},
        "tail": report.tail,
    }
    directory = Path(cache_dir)
    path = directory / f"{key}.json"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a container reading a half-written sentinel would
        # decide "not known to fail" and pay for the load, which is the outcome
        # this whole file is about.
        temp = directory / f"{key}.json.{os.getpid()}.tmp"
        temp.write_text(json.dumps(record, indent=2, sort_keys=True))
        temp.replace(path)
    except OSError as e:
        echo(f"[serve] could not record load failure: {e}")
        return None
    if commit is not None:
        try:
            commit()
        except Exception as e:  # noqa: BLE001 - a failed commit must not mask the failure
            echo(f"[serve] volume commit after load failure failed: {e}")
    return path


def raise_if_known_permanent(
    cache_dir: str | Path,
    key: str,
    *,
    env: dict[str, str] | None = None,
    echo: Callable[[str], None] = print,
) -> None:
    """
    First statement of `@modal.enter`. Fails in container-boot time, not in
    download-plus-load time, when this exact tuple has already proved unloadable.
    """
    if cache_disabled(env):
        echo(f"[serve] {IGNORE_CACHE_ENV} set — ignoring any recorded load failure")
        return
    record = lookup_permanent_failure(cache_dir, key)
    if record is None:
        return
    echo(
        f"[serve] LOAD-FAILURE-CACHED {json.dumps({k: record.get(k) for k in ('code', 'hint', 'recorded_at')}, sort_keys=True)}"
    )
    raise PermanentLoadFailure(record)


def log_failure(report: ServerExit, *, echo: Callable[[str], None] = print) -> None:
    """
    One machine-readable line per failure, so `modal app logs` is greppable and an
    ops job can pick the reason up without parsing llama.cpp's prose. This is the
    interim channel to the control plane: nothing in this container holds a
    credential that could write `custom_models` directly, and it should not.
    """
    payload = report.as_dict()
    # The tail is already on its way to the log verbatim via the tee; repeating all
    # fifty lines inside the JSON would make the one greppable line unreadable.
    payload["tail"] = report.tail[-3:]
    echo(f"[serve] LOAD-FAILURE {json.dumps(payload, sort_keys=True)}")
