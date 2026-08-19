"""
Offline test suite. No Modal token, no GPU, no spend.

    python -m unittest discover -s tools/modal -p "test_*.py" -v

The SSE analyzer is exercised two ways:
  1. against synthetic wire text, for exact control of the three usage cases; and
  2. end-to-end against tools/mock-upstream — a faithful OpenAI-SSE fake owned by
     another agent — so the parser is proved against a server we did not write.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.parse
import urllib.request

import deploy
from measure import (
    SseAnalyzer,
    analyze_sse_text,
    build_url,
    check_base_url,
    percentile,
    run_once,
    summarize,
)
from tiers import (
    MVP_TARGET_SHAPE,
    TIERS_BY_ID,
    Infeasible,
    ModelShape,
    evaluate_tier,
    select_tier,
)

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK_DIR = os.path.join(HERE, "..", "mock-upstream")


def _mock_cli() -> str | None:
    """
    tools/mock-upstream is owned by another agent and migrated from .js to .ts mid-flight.
    Node 24 runs TypeScript directly via type stripping, so accept either extension rather
    than pinning to one and silently skipping the whole end-to-end suite when it changes.
    """
    for name in ("cli.ts", "cli.js"):
        path = os.path.join(MOCK_DIR, name)
        if os.path.exists(path):
            return path
    return None


MOCK_CLI = _mock_cli()


def frame(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def chunk(delta=None, finish=None, usage=None, choices=None):
    o = {"id": "c1", "object": "chat.completion.chunk", "model": "m"}
    if choices is not None:
        o["choices"] = choices
    else:
        o["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
    if usage is not None:
        o["usage"] = usage
    return o


# ═════════════════════════════════════════════════════════════════════════════
# The three usage cases — the fact the whole tool exists to establish
# ═════════════════════════════════════════════════════════════════════════════


class TestUsageDetection(unittest.TestCase):
    def test_full_usage_with_cached_tokens(self):
        """vLLM / the real llama.cpp build: usage on a separate trailing chunk WITH cached_tokens."""
        body = (
            frame(chunk(delta={"content": "a"}))
            + frame(chunk(delta={"content": "b"}))
            + frame(chunk(delta={}, finish="stop"))
            + frame(
                chunk(
                    choices=[],
                    usage={
                        "prompt_tokens": 55,
                        "completion_tokens": 2,
                        "total_tokens": 57,
                        "prompt_tokens_details": {"cached_tokens": 42},
                    },
                )
            )
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertTrue(r.usage_emitted)
        self.assertEqual(r.usage_shape, "full")
        self.assertTrue(r.cached_tokens_reported)
        self.assertEqual(r.cached_tokens, 42)
        self.assertEqual(r.usage_placement, "separate")
        self.assertEqual(r.prompt_tokens, 55)
        self.assertEqual(r.completion_tokens_reported, 2)

    def test_basic_usage_no_cached_tokens(self):
        """llama.cpp best case: totals only, riding the finish chunk."""
        body = (
            frame(chunk(delta={"content": "a"}))
            + frame(
                chunk(
                    delta={},
                    finish="stop",
                    usage={
                        "prompt_tokens": 10,
                        "completion_tokens": 1,
                        "total_tokens": 11,
                    },
                )
            )
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertTrue(r.usage_emitted)
        self.assertEqual(r.usage_shape, "basic")
        self.assertFalse(r.cached_tokens_reported)
        self.assertIsNone(r.cached_tokens)
        self.assertEqual(r.usage_placement, "final")

    def test_no_usage_at_all(self):
        """llama.cpp worst case: the stream looks perfect and carries no counts."""
        body = (
            frame(chunk(delta={"content": "a"}))
            + frame(chunk(delta={}, finish="stop"))
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertFalse(r.usage_emitted)
        self.assertEqual(r.usage_shape, "none")
        self.assertFalse(r.cached_tokens_reported)
        self.assertIsNone(r.usage_placement)

    def test_cached_tokens_zero_still_counts_as_full(self):
        """cached_tokens: 0 means 'reported, and it was zero' — not 'not reported'."""
        body = (
            frame(
                chunk(
                    choices=[],
                    usage={
                        "prompt_tokens": 5,
                        "completion_tokens": 0,
                        "total_tokens": 5,
                        "prompt_tokens_details": {"cached_tokens": 0},
                    },
                )
            )
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertEqual(r.usage_shape, "full")
        self.assertTrue(r.cached_tokens_reported)
        self.assertEqual(r.cached_tokens, 0)


class TestReasoningTokens(unittest.TestCase):
    """
    Regression guard for a real, billing-critical bug found on the live MVP target: the
    model emits its chain-of-thought as `reasoning_content` and only the answer as
    `content`. Counting only `content` under-counted generated tokens by 89% on the very
    first live run, and reported TTFT as the time to the first ANSWER token rather than
    the first token the user actually sees.
    """

    def test_reasoning_content_counts_as_generated(self):
        body = (
            frame(chunk(delta={"reasoning_content": "think"}))
            + frame(chunk(delta={"reasoning_content": " more"}))
            + frame(chunk(delta={"content": "Hi"}))
            + frame(chunk(delta={}, finish="stop"))
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertEqual(r.completion_tokens_observed, 3)
        self.assertEqual(r.reasoning_tokens, 2)
        self.assertEqual(r.content_tokens, 1)
        self.assertEqual(r.text, "Hi")
        self.assertEqual(r.reasoning_text, "think more")

    def test_ttft_is_first_generated_token_not_first_content(self):
        body = (
            frame(chunk(delta={"reasoning_content": "t"}))
            + frame(chunk(delta={"content": "A"}))
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        # Injected clock ticks 1.0 per frame; the reasoning frame is the first tick.
        self.assertEqual(r.ttft_ms, 1000.0)

    def test_reasoning_only_stream_is_not_zero_tokens(self):
        """A truncated reasoning phase still generated (and still costs) tokens."""
        body = frame(chunk(delta={"reasoning_content": "x"})) + "data: [DONE]\n\n"
        r = analyze_sse_text(body)
        self.assertEqual(r.completion_tokens_observed, 1)


class TestStreamMechanics(unittest.TestCase):
    def test_malformed_frame_counted_not_fatal(self):
        body = (
            frame(chunk(delta={"content": "a"}))
            + 'data: {"choices": [trunc\n\n'
            + frame(chunk(delta={"content": "b"}))
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertEqual(r.malformed_frames, 1)
        self.assertEqual(r.completion_tokens_observed, 2)

    def test_keepalive_comments_are_not_tokens(self):
        body = (
            ": keepalive\n\n"
            + ": keepalive\n\n"
            + frame(chunk(delta={"content": "a"}))
            + "data: [DONE]\n\n"
        )
        r = analyze_sse_text(body)
        self.assertEqual(r.keepalives, 2)
        self.assertEqual(r.completion_tokens_observed, 1)

    def test_crlf_frame_separators(self):
        body = (
            frame(chunk(delta={"content": "a"})).replace("\n\n", "\r\n\r\n")
            + "data: [DONE]\r\n\r\n"
        )
        r = analyze_sse_text(body)
        self.assertEqual(r.completion_tokens_observed, 1)
        self.assertTrue(r.saw_done)

    def test_missing_done_sentinel_is_recorded(self):
        r = analyze_sse_text(frame(chunk(delta={"content": "a"})))
        self.assertFalse(r.saw_done)

    def test_split_chunk_boundaries_reassemble(self):
        """Frames arriving split mid-JSON must not be lost or double-counted."""
        body = frame(chunk(delta={"content": "hello"})) + "data: [DONE]\n\n"
        a = SseAnalyzer(now=lambda: 0.0, started_at=0.0)
        for i in range(0, len(body), 7):
            a.push(body[i : i + 7])
        r = a.finish()
        self.assertEqual(r.completion_tokens_observed, 1)
        self.assertTrue(r.saw_done)

    def test_decode_rate_excludes_ttft(self):
        """(n-1) intervals between n tokens — not tokens/total, which folds in prefill."""
        a = SseAnalyzer(now=lambda: 0.0, started_at=0.0)
        a.push(frame(chunk(delta={"content": "a"})), at=10.0)
        a.push(frame(chunk(delta={"content": "b"})), at=11.0)
        a.push(frame(chunk(delta={"content": "c"})), at=12.0)
        r = a.finish(at=12.0)
        self.assertEqual(r.ttft_ms, 10000.0)
        self.assertEqual(r.decode_span_ms, 2000.0)
        self.assertEqual(r.decode_tokens_per_second, 1.0)


class TestSummary(unittest.TestCase):
    def _run(self, cold, shape, tokens=64, ok=True):
        return {
            "ok": ok,
            "cold": cold,
            "headers_ms": 100.0,
            "ttft_ms": 200.0,
            "decode_tokens_per_second": 14.0,
            "total_ms": 5000.0,
            "completion_tokens_observed": tokens,
            "usage_shape": shape,
            "usage_emitted": shape != "none",
            "cached_tokens_reported": shape == "full",
            "usage_placement": "separate" if shape != "none" else None,
            "saw_done": True,
            "malformed_frames": 0,
        }

    def test_cold_and_warm_reported_separately(self):
        s = summarize([self._run(True, "full"), self._run(False, "full"), self._run(False, "full")])
        self.assertEqual(s["cold"]["runs"], 1)
        self.assertEqual(s["warm"]["runs"], 2)

    def test_intermittent_usage_is_flagged_not_averaged_away(self):
        """One good run in three is 'works sometimes', which is worse than never."""
        s = summarize([self._run(True, "full"), self._run(False, "none"), self._run(False, "full")])
        self.assertEqual(
            s["summary"]["usage_finding"]["verdict"]
            if "summary" in s
            else s["usage_finding"]["verdict"],
            "intermittent",
        )

    def test_all_none_verdict(self):
        s = summarize([self._run(True, "none"), self._run(False, "none")])
        self.assertEqual(s["usage_finding"]["verdict"], "none")

    def test_all_basic_verdict(self):
        s = summarize([self._run(True, "basic"), self._run(False, "basic")])
        self.assertEqual(s["usage_finding"]["verdict"], "basic")

    def test_short_generation_warns(self):
        s = summarize([self._run(True, "full", tokens=8)])
        self.assertTrue(any("fewer than 64 tokens" in w for w in s["warnings"]))

    def test_failed_run_excluded_from_stats_and_warned(self):
        s = summarize(
            [
                self._run(True, "full"),
                {"ok": False, "cold": True, "error": {"code": "timeout", "message": "x"}},
            ]
        )
        self.assertEqual(s["failed_runs"], 1)
        self.assertEqual(s["cold"]["runs"], 1)

    def test_percentile_nearest_rank(self):
        self.assertEqual(percentile([1, 2, 3, 4], 0.5), 2)
        self.assertEqual(percentile([1, 2, 3, 4], 0.95), 4)
        self.assertIsNone(percentile([], 0.5))


# ═════════════════════════════════════════════════════════════════════════════
# Solver
# ═════════════════════════════════════════════════════════════════════════════


class TestTiers(unittest.TestCase):
    def test_tier_list_is_not_an_ordered_ladder(self):
        """The property the comment in tiers.py claims must actually hold in the data."""
        by_id = TIERS_BY_ID
        # Same VRAM, 2x bandwidth apart.
        self.assertEqual(by_id["l4"].vram_bytes, by_id["a10g"].vram_bytes)
        self.assertLess(
            by_id["l4"].memory_bandwidth_bytes_s, by_id["a10g"].memory_bandwidth_bytes_s
        )
        # More VRAM, LESS bandwidth: the L40S is bigger and slower than the A100-40GB.
        self.assertGreater(by_id["l40s"].vram_bytes, by_id["a100_40"].vram_bytes)
        self.assertLess(
            by_id["l40s"].memory_bandwidth_bytes_s, by_id["a100_40"].memory_bandwidth_bytes_s
        )

    def test_hybrid_model_kv_is_a_quarter_of_naive(self):
        """Only 1 block in 4 keeps a KV cache; treating all 65 as attention over-counts 4x."""
        hybrid = ModelShape(**MVP_TARGET_SHAPE)
        naive = ModelShape(**{**MVP_TARGET_SHAPE, "full_attention_interval": None})
        self.assertEqual(hybrid.n_attention_layers, 16)
        self.assertEqual(hybrid.n_ssm_layers, 49)
        self.assertEqual(hybrid.kv_bytes_per_token, 65536)  # 64 KiB/token
        self.assertAlmostEqual(
            naive.kv_bytes_per_token / hybrid.kv_bytes_per_token, 65 / 16, places=2
        )

    def test_head_dim_is_key_length_not_hidden_over_heads(self):
        """head_dim 256 (declared key_length), not 213 (hidden_size/head_count)."""
        self.assertEqual(MVP_TARGET_SHAPE["head_dim"], 256)

    def test_selection_is_argmin_price_not_argmin_index(self):
        shape = ModelShape(**MVP_TARGET_SHAPE)
        p = select_tier(shape)
        eligible = [e for e in p.evaluations if e.fits and e.meets_speed]
        cheapest = min(e.usd_per_hour_micro for e in eligible)
        self.assertEqual(p.tier.usd_per_hour_micro, cheapest)

    def test_t4_rejected_because_weights_alone_do_not_fit(self):
        shape = ModelShape(**MVP_TARGET_SHAPE)
        ev = evaluate_tier(TIERS_BY_ID["t4"], shape)
        self.assertFalse(ev.fits)
        self.assertIn("exceed usable VRAM", ev.reject_reason)

    def test_l4_fits_but_misses_the_default_speed_target(self):
        shape = ModelShape(**MVP_TARGET_SHAPE)
        ev = evaluate_tier(TIERS_BY_ID["l4"], shape)
        self.assertTrue(ev.fits)
        self.assertFalse(ev.meets_speed)

    def test_impossible_model_raises_infeasible(self):
        huge = ModelShape(
            weights_bytes=900 * 1024**3,
            context_length=8192,
            n_layers=100,
            n_kv_heads=8,
            head_dim=128,
        )
        with self.assertRaises(Infeasible) as cm:
            select_tier(huge)
        self.assertEqual(cm.exception.code, "infeasible_no_fit")

    def test_long_context_collapses_concurrency(self):
        short = ModelShape(**MVP_TARGET_SHAPE)
        long = ModelShape(**{**MVP_TARGET_SHAPE, "context_length": 262144})
        a = evaluate_tier(TIERS_BY_ID["a100_80"], short)
        b = evaluate_tier(TIERS_BY_ID["a100_80"], long)
        self.assertGreater(a.max_concurrent_streams, b.max_concurrent_streams)


class TestDeployConfig(unittest.TestCase):
    def test_model_file_is_mandatory(self):
        with self.assertRaises(ValueError) as cm:
            deploy.resolve_config(
                model_repo="a/b",
                model_file="",
                weights_bytes=1000,
                context_length=8192,
                n_layers=65,
                n_kv_heads=4,
                head_dim=256,
            )
        self.assertIn("mandatory", str(cm.exception))

    def test_non_gguf_file_rejected(self):
        with self.assertRaises(ValueError):
            deploy.resolve_config(
                model_repo="a/b",
                model_file="model.safetensors",
                weights_bytes=1000,
                context_length=8192,
                n_layers=65,
                n_kv_heads=4,
                head_dim=256,
            )

    def test_mvp_target_resolves_to_a_deployed_class(self):
        cfg = deploy.resolve_config(
            model_repo="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
            model_file="Qwen3.8-27B-Uncensored-Q4_K_M.gguf",
            context_length=8192,
            **{
                k: v
                for k, v in MVP_TARGET_SHAPE.items()
                if k not in ("context_length", "target_tokens_per_second")
            },
        )
        self.assertIn(cfg["class_name"], deploy.TIER_CLASS_NAMES.values())
        self.assertEqual(cfg["scaling"]["min_containers"], 0)
        self.assertEqual(cfg["scaling"]["scaledown_window_s"], 30)

    def test_total_ctx_is_per_slot_times_parallel(self):
        cfg = deploy.resolve_config(
            model_repo="a/b",
            model_file="m.gguf",
            weights_bytes=MVP_TARGET_SHAPE["weights_bytes"],
            context_length=8192,
            n_layers=65,
            n_kv_heads=4,
            head_dim=256,
            full_attention_interval=4,
            pin_tier="l4",
            parallel_override=4,
        )
        self.assertEqual(cfg["llama_server_total_ctx"], 8192 * 4)

    def test_url_carries_parameters_as_query_string(self):
        url = deploy.web_url("LlamaServerL4", {"model_repo": "a/b", "model_file": "m.gguf"})
        self.assertIn("model_repo=a%2Fb", url)
        self.assertIn("/v1/chat/completions?", url)


# ═════════════════════════════════════════════════════════════════════════════
# End-to-end against tools/mock-upstream — a fake we did not write
# ═════════════════════════════════════════════════════════════════════════════


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(
    shutil.which("node") and MOCK_CLI,
    "node and tools/mock-upstream are required",
)
class TestAgainstMockUpstream(unittest.TestCase):
    proc = None
    port = None

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.proc = subprocess.Popen(
            ["node", MOCK_CLI, "--port", str(cls.port), "--quiet"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.5):
                    return
            except OSError:
                time.sleep(0.15)
        raise RuntimeError("mock-upstream did not start")

    @classmethod
    def tearDownClass(cls):
        if cls.proc:
            cls.proc.terminate()
            cls.proc.wait(timeout=10)

    def _url(self, **mock_opts) -> str:
        base = f"http://127.0.0.1:{self.port}/v2/ep_test/openai/v1/chat/completions"
        return base + ("?" + urllib.parse.urlencode(mock_opts) if mock_opts else "")

    def test_full_usage_end_to_end(self):
        rec = run_once(
            self._url(usage="full", tokens=70, cached_tokens=12),
            model="m",
            prompt="hi",
            max_tokens=70,
            timeout_s=30,
        )
        self.assertTrue(rec.ok, rec.error)
        self.assertEqual(rec.stream["usage_shape"], "full")
        self.assertTrue(rec.stream["cached_tokens_reported"])
        self.assertEqual(rec.stream["cached_tokens"], 12)
        self.assertEqual(rec.stream["completion_tokens_observed"], 70)

    def test_basic_usage_end_to_end(self):
        rec = run_once(
            self._url(usage="basic", tokens=64), model="m", prompt="hi", max_tokens=64, timeout_s=30
        )
        self.assertTrue(rec.ok, rec.error)
        self.assertEqual(rec.stream["usage_shape"], "basic")
        self.assertFalse(rec.stream["cached_tokens_reported"])

    def test_no_usage_end_to_end(self):
        rec = run_once(
            self._url(usage="none", tokens=64), model="m", prompt="hi", max_tokens=64, timeout_s=30
        )
        self.assertTrue(rec.ok, rec.error)
        self.assertEqual(rec.stream["usage_shape"], "none")
        self.assertFalse(rec.stream["usage_emitted"])

    def test_ttft_reflects_injected_cold_start(self):
        rec = run_once(
            self._url(usage="basic", tokens=64, cold_start_ms=1200),
            model="m",
            prompt="hi",
            max_tokens=64,
            timeout_s=60,
        )
        self.assertTrue(rec.ok, rec.error)
        self.assertGreaterEqual(rec.headers_ms, 1000)
        self.assertGreaterEqual(rec.stream["ttft_ms"], 1000)

    def test_upstream_error_is_recorded_not_raised(self):
        rec = run_once(self._url(fail="500"), model="m", prompt="hi", max_tokens=8, timeout_s=30)
        self.assertFalse(rec.ok)
        self.assertEqual(rec.error["code"], "http_500")

    def test_truncated_stream_has_no_done_sentinel(self):
        rec = run_once(
            self._url(usage="basic", tokens=20, fail="drop", drop_after=3),
            model="m",
            prompt="hi",
            max_tokens=20,
            timeout_s=30,
        )
        self.assertFalse(rec.stream["saw_done"])

    def test_stream_options_include_usage_is_always_sent(self):
        """
        The gateway must inject stream_options.include_usage unconditionally. This tool
        does the same, so a 'none' verdict is a fact about the build and never about the
        tool having forgotten to ask. honor_include_usage=true makes the mock withhold
        usage unless the flag is present, so this test fails loudly if it regresses.
        """
        rec = run_once(
            self._url(usage="full", tokens=64, honor_include_usage="true"),
            model="m",
            prompt="hi",
            max_tokens=64,
            timeout_s=30,
        )
        self.assertTrue(rec.ok, rec.error)
        self.assertEqual(rec.stream["usage_shape"], "full")

    def test_build_url_shape(self):
        u = build_url("http://x/base/", {"model_repo": "a/b", "ctx_size": 8192})
        self.assertEqual(u, "http://x/base/v1/chat/completions?model_repo=a%2Fb&ctx_size=8192")

    def test_base_url_must_be_http(self):
        # urllib opens file:// and bare hostnames without complaint, so a typo'd --url
        # would otherwise be measured as if it were an inference endpoint.
        self.assertIsNone(check_base_url("https://ws--app-serve.modal.run"))
        self.assertIsNotNone(check_base_url("file:///etc/passwd"))
        self.assertIsNotNone(check_base_url("localhost:8000"))
        self.assertIsNotNone(check_base_url("http://"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
