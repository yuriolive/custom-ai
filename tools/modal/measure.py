"""
measure.py — measure the real cold-start behavior the scale-to-zero thesis rests on.

Scale-to-zero is the business model, which makes cold start a product surface rather
than a performance footnote. This tool produces the numbers that decide whether the
product works: time to response headers, time to first token, decode throughput over
>= 64 generated tokens, and total duration — p50/p95, cold and warm reported SEPARATELY,
because averaging them describes a request nobody ever makes.

═══════════════════════════════════════════════════════════════════════════════
THE SINGLE MOST VALUABLE OUTPUT: the usage finding.

llama.cpp's `usage` emission on the OpenAI route is BUILD-dependent. Nothing errors when
a build omits it — the stream looks perfect, the gateway silently falls back to a
character estimator, and billing drifts from truth with no alarm anywhere. So before an
image tag is pinned, this tool answers three questions:

  1. did a `usage` object appear on the stream AT ALL?    -> bill from real counts, or estimate
  2. did it carry prompt_tokens_details.cached_tokens?    -> can cached prompt tokens be
                                                             billed correctly?
  3. where did it appear — a separate trailing chunk, or  -> which wire layout the gateway's
     the finish chunk?                                       usage tee must handle

"full" lets the gateway bill from real counts. "basic" bills from real totals with no
cached-token discount. "none" forces the estimator for every request on that image —
a decision to make deliberately, not to discover in production.
═══════════════════════════════════════════════════════════════════════════════

Offline-testable: the SSE analyzer below is pure and has no clock of its own, so the
test suite drives it against tools/mock-upstream (a faithful OpenAI-SSE fake) with no
GPU, no token, and no spend.

SECURITY: Modal credentials come from the environment or ~/.modal.toml only. They are
never logged and never written to a report.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field

# ═════════════════════════════════════════════════════════════════════════════
# SSE analyzer — the testable core. Pure; the clock is injected.
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class StreamResult:
    frames: int = 0
    malformed_frames: int = 0
    keepalives: int = 0
    saw_done: bool = False
    finish_reason: str | None = None
    model: str | None = None
    completion_tokens_observed: int = 0  # ALL generated tokens (content + reasoning)
    content_tokens: int = 0  # tokens in delta.content
    reasoning_tokens: int = 0  # tokens in delta.reasoning_content
    text: str = ""
    reasoning_text: str = ""
    system_fingerprint: str | None = None  # llama.cpp build id — what "pinning" pins
    server_timings: dict | None = None  # llama.cpp's own timings block, if present

    ttft_ms: float | None = None
    last_token_ms: float | None = None
    total_ms: float | None = None
    decode_span_ms: float = 0.0
    decode_tokens_per_second: float | None = None
    end_to_end_tokens_per_second: float | None = None

    # ── The finding that decides how the gateway bills ────────────────────────
    usage_emitted: bool = False
    usage_shape: str = "none"  # "full" | "basic" | "none"
    usage_placement: str | None = None  # "separate" | "final"
    cached_tokens_reported: bool = False
    usage: dict | None = None
    prompt_tokens: int | None = None
    completion_tokens_reported: int | None = None
    cached_tokens: int | None = None
    raw_usage_frame: str | None = None  # verbatim, for the report

    def to_dict(self) -> dict:
        return asdict(self)


class SseAnalyzer:
    """
    Accumulates OpenAI SSE frames and reports what was actually on the wire.

    `now` is injected so tests are deterministic and the live path uses a real clock.
    """

    def __init__(self, now=None, started_at: float | None = None):
        self._now = now or time.monotonic
        self.t0 = started_at if started_at is not None else self._now()
        self._buf = ""
        self.r = StreamResult()
        self._first_token_at: float | None = None
        self._last_token_at: float | None = None
        self._done_at: float | None = None

    def push(self, chunk: str, at: float | None = None) -> None:
        at = self._now() if at is None else at
        self._buf += chunk
        while True:
            # Frames are separated by a blank line. Tolerate \r\n: some proxies rewrite it.
            idx_n = self._buf.find("\n\n")
            idx_rn = self._buf.find("\r\n\r\n")
            if idx_n == -1 and idx_rn == -1:
                break
            if idx_rn != -1 and (idx_n == -1 or idx_rn < idx_n):
                frame, self._buf = self._buf[:idx_rn], self._buf[idx_rn + 4 :]
            else:
                frame, self._buf = self._buf[:idx_n], self._buf[idx_n + 2 :]
            self._handle_frame(frame, at)

    def _handle_frame(self, frame: str, at: float) -> None:
        for line in frame.replace("\r\n", "\n").split("\n"):
            if not line.strip():
                continue
            # ": keepalive" — an SSE comment. The gateway emits these during upstream
            # silence; a worker generally does not. Counted, never billed.
            if line.startswith(":"):
                self.r.keepalives += 1
                continue
            if not line.startswith("data:"):
                continue

            payload = line[5:].strip()
            if payload == "[DONE]":
                self.r.saw_done = True
                self._done_at = at
                continue

            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                # A truncated frame is a real failure mode, not a parsing inconvenience.
                # A stream that silently loses frames also silently loses usage.
                self.r.malformed_frames += 1
                continue

            self.r.frames += 1
            if obj.get("model") and self.r.model is None:
                self.r.model = obj["model"]

            choices = obj.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices else None
            delta = (choice or {}).get("delta") or {}
            # A reasoning model emits its chain-of-thought as `reasoning_content` and
            # only the final answer as `content`. BOTH are generated tokens: both cost GPU
            # time, both are counted by the worker's own `usage.completion_tokens`, and
            # both must therefore be billed. Counting only `content` under-counts a
            # reasoning model's output by the entire length of its thinking phase — on the
            # MVP target's first test that was 24 of 27 tokens, i.e. an 89% under-count.
            # It also mis-measures TTFT, since the user sees activity at the first
            # reasoning token, not at the first answer token.
            content = delta.get("content")
            reasoning = delta.get("reasoning_content")
            produced = False
            if isinstance(content, str) and content:
                self.r.content_tokens += 1
                self.r.text += content
                produced = True
            if isinstance(reasoning, str) and reasoning:
                self.r.reasoning_tokens += 1
                self.r.reasoning_text += reasoning
                produced = True
            if produced:
                self.r.completion_tokens_observed += 1
                if self._first_token_at is None:
                    self._first_token_at = at
                self._last_token_at = at
            if choice and choice.get("finish_reason") and self.r.finish_reason is None:
                self.r.finish_reason = choice["finish_reason"]

            if obj.get("system_fingerprint") and self.r.system_fingerprint is None:
                self.r.system_fingerprint = obj["system_fingerprint"]
            # llama.cpp attaches a non-standard `timings` block alongside usage, carrying
            # its own server-side predicted_per_second. That is ground truth for decode
            # throughput, free of client-side network jitter — worth capturing to
            # calibrate the solver's MFU constant against reality.
            if isinstance(obj.get("timings"), dict):
                self.r.server_timings = obj["timings"]

            usage = obj.get("usage")
            if isinstance(usage, dict):
                self.r.usage = usage
                self.r.raw_usage_frame = payload
                # Placement matters to the gateway's usage tee: a trailing chunk with
                # choices:[] is the vLLM layout; usage on the finish chunk is llama.cpp's.
                has_choices = isinstance(choices, list) and len(choices) > 0
                self.r.usage_placement = "final" if has_choices else "separate"

    def finish(self, at: float | None = None) -> StreamResult:
        at = self._now() if at is None else at
        if self._buf.strip():
            self._handle_frame(self._buf, at)
        self._buf = ""
        end = self._done_at if self._done_at is not None else at

        r = self.r
        u = r.usage
        cached = None
        if isinstance(u, dict):
            details = u.get("prompt_tokens_details")
            if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
                cached = details["cached_tokens"]

        r.usage_emitted = u is not None
        r.cached_tokens_reported = cached is not None
        # The three cases the gateway's billing path must distinguish.
        r.usage_shape = "none" if u is None else ("full" if cached is not None else "basic")
        r.cached_tokens = cached
        if isinstance(u, dict):
            r.prompt_tokens = (
                u.get("prompt_tokens") if isinstance(u.get("prompt_tokens"), int) else None
            )
            ct = u.get("completion_tokens")
            r.completion_tokens_reported = ct if isinstance(ct, int) else None

        ms = lambda a, b: round((a - b) * 1000, 1)  # noqa: E731
        r.ttft_ms = ms(self._first_token_at, self.t0) if self._first_token_at is not None else None
        r.last_token_ms = (
            ms(self._last_token_at, self.t0) if self._last_token_at is not None else None
        )
        r.total_ms = ms(end, self.t0)

        if self._first_token_at is not None and self._last_token_at is not None:
            r.decode_span_ms = ms(self._last_token_at, self._first_token_at)
        # Decode rate EXCLUDES time-to-first-token: (n-1) intervals between n tokens.
        # This is the number to compare against a throughput target, and it is NOT
        # tokens / total_duration — that conflates queueing and prefill with decoding.
        if r.decode_span_ms > 0 and r.completion_tokens_observed > 1:
            r.decode_tokens_per_second = round(
                (r.completion_tokens_observed - 1) / (r.decode_span_ms / 1000), 2
            )
        if r.total_ms and r.total_ms > 0 and r.completion_tokens_observed > 0:
            r.end_to_end_tokens_per_second = round(
                r.completion_tokens_observed / (r.total_ms / 1000), 2
            )
        return r


def analyze_sse_text(text: str) -> StreamResult:
    """Analyze a complete SSE body at once. Used by the offline tests."""
    counter = {"t": 0.0}

    def clock():
        counter["t"] += 1.0
        return counter["t"]

    a = SseAnalyzer(now=clock, started_at=0.0)
    a.push(text)
    return a.finish()


# ═════════════════════════════════════════════════════════════════════════════
# One measured request
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class RunRecord:
    cold: bool
    started_at: str
    ok: bool = False
    http_status: int | None = None
    headers_ms: float | None = None
    error: dict | None = None
    max_tokens_requested: int = 96
    stream: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(self.stream)
        d.pop("stream", None)
        return d


def run_once(
    url: str,
    *,
    model: str,
    prompt: str,
    max_tokens: int = 96,
    timeout_s: float = 600.0,
    cold: bool = False,
    headers: dict | None = None,
) -> RunRecord:
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "max_tokens": max_tokens,
            "temperature": 0,
            # Sent unconditionally, exactly as the gateway does. vLLM emits no usage
            # without it; llama.cpp ignores it. Branching on runtime is how the flag gets
            # dropped, so a "none" result here is a fact about the BUILD, not about this
            # tool having forgotten to ask.
            "stream_options": {"include_usage": True},
        }
    ).encode()

    req_headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    req_headers.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")

    rec = RunRecord(cold=cold, started_at=time_iso(), max_tokens_requested=max_tokens)
    t0 = time.monotonic()
    analyzer = SseAnalyzer(started_at=t0)

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            # Time to response headers. On a cold worker this is the window during which
            # the gateway must already have flushed ITS headers and be emitting
            # keepalives — the client socket is otherwise silent for the whole load.
            rec.headers_ms = round((time.monotonic() - t0) * 1000, 1)
            rec.http_status = resp.status
            while True:
                chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                if not chunk:
                    break
                analyzer.push(chunk.decode("utf-8", "replace"))
        res = analyzer.finish()
        rec.stream = res.to_dict()
        rec.ok = res.completion_tokens_observed > 0
        if not rec.ok:
            rec.error = {"code": "no_tokens", "message": "stream produced no content tokens"}
    except urllib.error.HTTPError as e:
        rec.headers_ms = round((time.monotonic() - t0) * 1000, 1)
        rec.http_status = e.code
        detail = ""
        # Reading the error body is best-effort: the socket may already be gone.
        # A failure here must not mask the HTTPError we are actually reporting.
        with contextlib.suppress(Exception):
            detail = e.read().decode("utf-8", "replace")[:500]
        rec.error = {"code": f"http_{e.code}", "message": detail}
        rec.stream = analyzer.finish().to_dict()
    except Exception as e:  # noqa: BLE001 — a transport failure is data, not a crash
        rec.error = {"code": type(e).__name__, "message": str(e)[:500]}
        rec.stream = analyzer.finish().to_dict()

    return rec


def time_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ═════════════════════════════════════════════════════════════════════════════
# Statistics
# ═════════════════════════════════════════════════════════════════════════════


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile. No interpolation: with n=3, interpolating invents data."""
    xs = sorted(v for v in values if isinstance(v, (int, float)) and not math.isnan(v))
    if not xs:
        return None
    idx = min(len(xs) - 1, max(0, math.ceil(q * len(xs)) - 1))
    return round(xs[idx], 1)


def _stats(records: list[dict], field_name: str) -> dict:
    vals = [r.get(field_name) for r in records]
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return {"n": 0, "p50": None, "p95": None, "min": None, "max": None, "mean": None}
    return {
        "n": len(vals),
        "p50": percentile(vals, 0.50),
        "p95": percentile(vals, 0.95),
        "min": round(min(vals), 1),
        "max": round(max(vals), 1),
        "mean": round(statistics.fmean(vals), 1),
    }


def summarize(records: list[dict]) -> dict:
    ok = [r for r in records if r.get("ok")]

    def group(is_cold: bool) -> dict:
        g = [r for r in ok if r.get("cold") is is_cold]
        return {
            "runs": len(g),
            "headers_ms": _stats(g, "headers_ms"),
            "ttft_ms": _stats(g, "ttft_ms"),
            "decode_tokens_per_second": _stats(g, "decode_tokens_per_second"),
            "total_ms": _stats(g, "total_ms"),
            "completion_tokens": _stats(g, "completion_tokens_observed"),
        }

    # ── The usage finding. Deliberately pessimistic: if ANY run failed to emit usage,
    #    the image cannot be trusted to emit it. One good run in five is not "it works",
    #    it is "it works sometimes" — which is worse than never, because the drift is
    #    invisible and unreproducible.
    shapes = [r.get("usage_shape") for r in ok]
    any_usage = any(s and s != "none" for s in shapes)
    all_usage = bool(shapes) and all(s and s != "none" for s in shapes)
    all_cached = bool(ok) and all(r.get("cached_tokens_reported") for r in ok)
    any_cached = any(r.get("cached_tokens_reported") for r in ok)

    if not any_usage:
        verdict = "none"
        implication = (
            "NO usage object appeared on any stream. This image CANNOT be billed from real "
            "token counts: every request must settle from the gateway's estimator. Either pin "
            "a different llama.cpp build, or accept estimator-based billing knowingly and "
            "monitor the drift. Nothing will error to tell you."
        )
    elif not all_usage:
        verdict = "intermittent"
        implication = (
            "usage appeared on SOME runs and not others. Treat this as 'none' for pinning "
            "purposes: an intermittent source is worse than an absent one, because the drift "
            "is invisible and unreproducible. Investigate before pinning this image."
        )
    elif all_cached:
        verdict = "full"
        implication = (
            "usage is present on every run AND carries prompt_tokens_details.cached_tokens. "
            "The gateway can bill from real counts and apply cached-prompt-token handling."
        )
    else:
        verdict = "basic"
        implication = (
            "usage is present on every run but carries NO prompt_tokens_details.cached_tokens "
            "— the documented llama.cpp best case. The gateway bills from real prompt and "
            "completion totals; cached prompt tokens are billed at full price because the "
            "worker does not report them. Correct and safe, merely not optimal."
        )

    return {
        "total_runs": len(records),
        "ok_runs": len(ok),
        "failed_runs": len(records) - len(ok),
        "cold": group(True),
        "warm": group(False),
        "usage_finding": {
            "verdict": verdict,
            "usage_emitted_runs": sum(1 for r in ok if r.get("usage_emitted")),
            "cached_tokens_runs": sum(1 for r in ok if r.get("cached_tokens_reported")),
            "any_usage": any_usage,
            "all_usage": all_usage,
            "any_cached_tokens": any_cached,
            "all_cached_tokens": all_cached,
            "placements": sorted({r["usage_placement"] for r in ok if r.get("usage_placement")}),
            "raw_usage_frame": next(
                (r.get("raw_usage_frame") for r in ok if r.get("raw_usage_frame")), None
            ),
            "billing_implication": implication,
        },
        "warnings": _warnings(records, ok),
    }


def _warnings(records: list[dict], ok: list[dict]) -> list[str]:
    w = []
    short = [r for r in ok if r.get("completion_tokens_observed", 0) < 64]
    if short:
        w.append(
            f"{len(short)}/{len(ok)} successful runs generated fewer than 64 tokens "
            f"(min {min(r['completion_tokens_observed'] for r in short)}). Throughput measured "
            f"over a short window is dominated by noise; >= 64 generated tokens is the floor. "
            f"Raise --max-tokens or use a prompt that elicits a longer answer."
        )
    mal = [r for r in records if r.get("malformed_frames")]
    if mal:
        w.append(
            f"{len(mal)} run(s) contained malformed SSE frames — a stream losing frames can also lose usage."
        )
    nodone = [r for r in ok if not r.get("saw_done")]
    if nodone:
        w.append(
            f"{len(nodone)} run(s) ended without a [DONE] sentinel — the stream was truncated."
        )
    for f in (r for r in records if not r.get("ok")):
        w.append(
            f"run failed: {(f.get('error') or {}).get('code')} — {(f.get('error') or {}).get('message')}"
        )
    mismatch = [
        r
        for r in ok
        if isinstance(r.get("completion_tokens_reported"), int)
        and abs(r["completion_tokens_reported"] - r.get("completion_tokens_observed", 0)) > 1
    ]
    if mismatch:
        w.append(
            f"{len(mismatch)} run(s) reported a completion_tokens that disagrees with the observed "
            f"frame count by more than 1. The worker's own count is authoritative for billing, but a "
            f"large gap means one content frame != one token on this build — do not use frame counts "
            f"as an estimator basis."
        )
    return w


# ═════════════════════════════════════════════════════════════════════════════
# The measurement run
# ═════════════════════════════════════════════════════════════════════════════

DEFAULT_PROMPT = (
    "Write a detailed, factual paragraph explaining how a printing press works. "
    "Include at least six sentences."
)


def measure(
    url: str,
    *,
    model: str,
    prompt: str = DEFAULT_PROMPT,
    cold_runs: int = 3,
    warm_runs: int = 3,
    max_tokens: int = 96,
    timeout_s: float = 600.0,
    scaledown_window_s: int = 30,
    cold_wait_s: int | None = None,
    headers: dict | None = None,
    log=lambda s: None,
) -> dict:
    """
    Alternates forced-cold and warm requests.

    A cold container is forced by waiting out `scaledown_window` plus a margin, after
    which Modal has scaled the pool to zero and the next request pays the full container
    start + model load. Warm samples are taken IMMEDIATELY after a cold one, while the
    same container is still alive, so the pair differ in exactly one variable.
    """
    wait = scaledown_window_s + 15 if cold_wait_s is None else cold_wait_s
    records: list[RunRecord] = []

    for i in range(cold_runs):
        if wait > 0:
            log(
                f"[cold {i + 1}/{cold_runs}] waiting {wait}s for scaledown_window={scaledown_window_s}s to scale to zero..."
            )
            time.sleep(wait)
        log(f"[cold {i + 1}/{cold_runs}] requesting...")
        rec = run_once(
            url,
            model=model,
            prompt=prompt,
            max_tokens=max_tokens,
            timeout_s=timeout_s,
            cold=True,
            headers=headers,
        )
        records.append(rec)
        log(f"[cold {i + 1}/{cold_runs}] {_fmt(rec)}")

        # Warm samples ride the container the cold run just started.
        n_warm = warm_runs if i == cold_runs - 1 else max(1, warm_runs // cold_runs)
        for j in range(n_warm):
            log(f"[warm {i + 1}.{j + 1}] requesting immediately, same container...")
            rec = run_once(
                url,
                model=model,
                prompt=prompt,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
                cold=False,
                headers=headers,
            )
            records.append(rec)
            log(f"[warm {i + 1}.{j + 1}] {_fmt(rec)}")

    dicts = [r.to_dict() for r in records]
    return {
        "generated_at": time_iso(),
        "config": {
            "url": url,
            "model": model,
            "cold_runs": cold_runs,
            "warm_runs": warm_runs,
            "max_tokens": max_tokens,
            "cold_wait_s": wait,
            "scaledown_window_s": scaledown_window_s,
            "timeout_s": timeout_s,
            # Credentials are never recorded — only whether any were sent.
            "auth_headers_sent": sorted(headers.keys()) if headers else [],
        },
        "summary": summarize(dicts),
        "runs": dicts,
    }


def _fmt(rec: RunRecord) -> str:
    if not rec.ok:
        return (
            f"FAILED {(rec.error or {}).get('code')}: {(rec.error or {}).get('message', '')[:160]}"
        )
    s = rec.stream
    return (
        f"headers {rec.headers_ms}ms · TTFT {s.get('ttft_ms')}ms · "
        f"{s.get('completion_tokens_observed')} tok · {s.get('decode_tokens_per_second')} tok/s · "
        f"total {s.get('total_ms')}ms · usage={s.get('usage_shape')}"
    )


# ═════════════════════════════════════════════════════════════════════════════
# Readable summary
# ═════════════════════════════════════════════════════════════════════════════


def render_summary(report: dict) -> str:
    s = report["summary"]
    cfg = report["config"]
    L: list[str] = []
    bar = "=" * 78

    def stat(label: str, st: dict, unit: str) -> str:
        if st["n"] == 0:
            return f"  {label:<26} -"
        return (
            f"  {label:<26} p50 {str(st['p50']):>9}{unit}   p95 {str(st['p95']):>9}{unit}"
            f"   (min {st['min']} / max {st['max']}, n={st['n']})"
        )

    L += [bar, "Modal cold-start measurement", bar]
    L.append(f"  url        {cfg['url']}")
    L.append(f"  model      {cfg['model']}")
    L.append(
        f"  runs       {s['ok_runs']} ok / {s['total_runs']} total  ({s['failed_runs']} failed)"
    )
    L.append(
        f"  policy     scaledown_window={cfg['scaledown_window_s']}s, cold forced by a {cfg['cold_wait_s']}s wait"
    )
    L.append("")
    L.append(f"-- COLD ({s['cold']['runs']} runs) -- first request after scale-to-zero " + "-" * 12)
    L.append(stat("time to headers", s["cold"]["headers_ms"], "ms"))
    L.append(stat("time to first token", s["cold"]["ttft_ms"], "ms"))
    L.append(stat("decode throughput", s["cold"]["decode_tokens_per_second"], " tok/s"))
    L.append(stat("total duration", s["cold"]["total_ms"], "ms"))
    L.append(stat("completion tokens", s["cold"]["completion_tokens"], " tok"))
    L.append("")
    L.append(f"-- WARM ({s['warm']['runs']} runs) -- same container, still alive " + "-" * 20)
    L.append(stat("time to headers", s["warm"]["headers_ms"], "ms"))
    L.append(stat("time to first token", s["warm"]["ttft_ms"], "ms"))
    L.append(stat("decode throughput", s["warm"]["decode_tokens_per_second"], " tok/s"))
    L.append(stat("total duration", s["warm"]["total_ms"], "ms"))
    L.append(stat("completion tokens", s["warm"]["completion_tokens"], " tok"))

    L += ["", "=" * 78, "USAGE FINDING -- the output that decides how the gateway bills", "=" * 78]
    uf = s["usage_finding"]
    L.append(f"  verdict                      {uf['verdict'].upper()}")
    L.append(
        f"  usage object emitted         {uf['usage_emitted_runs']}/{s['ok_runs']} successful runs"
    )
    L.append(f"  cached_tokens present        {uf['cached_tokens_runs']}/{s['ok_runs']} runs")
    L.append(f"  wire placement               {', '.join(uf['placements']) or 'n/a'}")
    L.append("")
    for line in _wrap(uf["billing_implication"], 74):
        L.append("  " + line)
    if uf.get("raw_usage_frame"):
        L += ["", "  raw usage frame (verbatim):"]
        L.append("    " + uf["raw_usage_frame"][:900])

    if s["warnings"]:
        L += ["", "-- WARNINGS " + "-" * 66]
        for w in s["warnings"]:
            for line in _wrap("* " + w, 74):
                L.append("  " + line)
    L.append(bar)
    return "\n".join(L)


def _wrap(text: str, width: int) -> list[str]:
    words, lines, cur = str(text).split(), [], ""
    for word in words:
        if len((cur + " " + word).strip()) > width:
            lines.append(cur.strip())
            cur = word
        else:
            cur += " " + word
    if cur.strip():
        lines.append(cur.strip())
    return lines


# ═════════════════════════════════════════════════════════════════════════════
# CLI
# ═════════════════════════════════════════════════════════════════════════════


def build_url(base: str, params: dict | None) -> str:
    """
    Modal binds a parameterized class's parameters through the QUERY STRING of the web
    endpoint URL, and the query string is what selects the container pool. The path after
    the base URL is forwarded to the container's own HTTP server.
    """
    base = base.rstrip("/")
    url = f"{base}/v1/chat/completions"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    return url


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Measure Modal cold start and the llama.cpp usage-emission fact.",
    )
    ap.add_argument(
        "--url", required=True, help="Modal web endpoint base URL, or a mock-upstream base"
    )
    ap.add_argument("--model", default="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF")
    ap.add_argument("--model-repo", default=None, help="Modal class parameter model_repo")
    ap.add_argument("--model-file", default=None, help="Modal class parameter model_file")
    ap.add_argument("--ctx-size", type=int, default=None)
    ap.add_argument("--parallel", type=int, default=None)
    ap.add_argument("--path", default=None, help="override the full request path+query")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--cold-runs", type=int, default=3)
    ap.add_argument("--warm-runs", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=96)
    ap.add_argument("--cold-wait-s", type=int, default=None)
    ap.add_argument("--scaledown-window-s", type=int, default=30)
    ap.add_argument("--timeout-s", type=float, default=600.0)
    ap.add_argument("--out", default=None, help="write the JSON report here")
    ap.add_argument(
        "--json", action="store_true", help="print JSON instead of the readable summary"
    )
    ap.add_argument(
        "--proxy-auth",
        action="store_true",
        help="send Modal-Key / Modal-Secret from MODAL_KEY / MODAL_SECRET env vars",
    )
    args = ap.parse_args(argv)

    if args.path:
        url = args.url.rstrip("/") + args.path
    else:
        params = {}
        if args.model_repo:
            params["model_repo"] = args.model_repo
        if args.model_file:
            params["model_file"] = args.model_file
        if args.ctx_size is not None:
            params["ctx_size"] = args.ctx_size
        if args.parallel is not None:
            params["parallel"] = args.parallel
        url = build_url(args.url, params)

    headers = {}
    if args.proxy_auth:
        # Modal proxy auth takes the workspace PROXY token pair (wk-… / ws-…), which is a
        # different credential class from the API token (ak-… / as-…) used to deploy.
        # The header-pair form below is the primary one; Modal also accepts the single
        # header `Authorization: Bearer wk-….ws-…` for OpenAI-SDK compatibility (verified
        # live on 1.5.4). Plain `Bearer <secret>` is NOT a thing — that is the shape this
        # comment used to warn about.
        key, secret = os.environ.get("MODAL_KEY"), os.environ.get("MODAL_SECRET")
        if not key or not secret:
            print(
                "[error] --proxy-auth needs MODAL_KEY and MODAL_SECRET in the environment",
                file=sys.stderr,
            )
            return 2
        headers["Modal-Key"] = key
        headers["Modal-Secret"] = secret

    report = measure(
        url,
        model=args.model,
        prompt=args.prompt,
        cold_runs=args.cold_runs,
        warm_runs=args.warm_runs,
        max_tokens=args.max_tokens,
        timeout_s=args.timeout_s,
        scaledown_window_s=args.scaledown_window_s,
        cold_wait_s=args.cold_wait_s,
        headers=headers or None,
        log=lambda s: print(s, file=sys.stderr, flush=True),
    )

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\n[report] {os.path.abspath(args.out)}", file=sys.stderr)

    print(json.dumps(report, indent=2) if args.json else render_summary(report))
    return 0 if report["summary"]["ok_runs"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
