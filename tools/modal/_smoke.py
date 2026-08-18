"""Scratch smoke test: cold-start the L4 pool and stream one completion. Deleted after."""
import json
import time
import urllib.parse
import urllib.request

BASE = "https://yolive--nexus-llamacpp-llamaserverl4-serve.modal.run"
PARAMS = {
    "model_repo": "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    "model_file": "Qwen3.8-27B-Uncensored-Q4_K_M.gguf",
    "ctx_size": 8192,
    "parallel": 1,
}
qs = urllib.parse.urlencode(PARAMS)

body = json.dumps({
    "model": "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    "messages": [{"role": "user", "content": "Say hello in exactly five words."}],
    "stream": True,
    "max_tokens": 24,
    "stream_options": {"include_usage": True},
}).encode()

url = f"{BASE}/v1/chat/completions?{qs}"
print("POST", url, flush=True)
req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")

t0 = time.monotonic()
try:
    with urllib.request.urlopen(req, timeout=900) as resp:
        print(f"[{time.monotonic()-t0:7.1f}s] HTTP {resp.status} {resp.headers.get('content-type')}", flush=True)
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.strip():
                print(f"[{time.monotonic()-t0:7.1f}s] {line[:300]}", flush=True)
except Exception as e:
    print(f"[{time.monotonic()-t0:7.1f}s] ERROR {type(e).__name__}: {e}", flush=True)
    if hasattr(e, "read"):
        print(e.read().decode("utf-8", "replace")[:2000], flush=True)
