"""Scratch: dump the raw SSE bytes from the live endpoint. Deleted after."""
import json, time, urllib.parse, urllib.request

BASE = "https://yolive--nexus-llamacpp-llamaserverl4-serve.modal.run"
qs = urllib.parse.urlencode({
    "model_repo": "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    "model_file": "Qwen3.8-27B-Uncensored-Q4_K_M.gguf",
    "ctx_size": 8192, "parallel": 1,
})
body = json.dumps({
    "model": "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    "messages": [{"role": "user", "content": "Say hello."}],
    "stream": True, "max_tokens": 40, "temperature": 0,
    "stream_options": {"include_usage": True},
}).encode()

req = urllib.request.Request(f"{BASE}/v1/chat/completions?{qs}", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
t0 = time.monotonic()
with urllib.request.urlopen(req, timeout=700) as resp:
    print("HTTP", resp.status, dict(resp.headers), flush=True)
    n = 0
    for raw in resp:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if not line.strip():
            continue
        n += 1
        if n <= 6 or n % 15 == 0 or "usage" in line or "[DONE]" in line or "finish_reason" in line:
            print(f"[{n:3d}] {line[:600]}", flush=True)
print(f"total lines={n} elapsed={time.monotonic()-t0:.1f}s")
