---
# ca-abmv
title: 'Supervise llama-server: kill the container instead of billing a GPU that cannot serve'
status: completed
type: bug
priority: high
created_at: 2026-08-20T03:27:50Z
updated_at: 2026-08-20T03:43:22Z
parent: ca-l5oz
---

GitHub issue #36. `_launch_llama_server()` drops its `Popen` handle and `_wait_until_ready()` cannot tell "still loading" from "exited ten seconds ago", so a container whose llama-server died during model load sits in the poll loop against a dead port for up to 600 s (or Modal's 900 s startup_timeout) holding a GPU. The same blind spot exists after readiness: a server that dies mid-life leaves `@modal.web_server` proxying to a closed port for the rest of scaledown_window.

Observed live in app `nexus-llamacpp`, container `ta-01M0EGNNDZ2WKY4137RP23AD4R`: CUDA OOM on a 46 GiB KV allocation, server gone 10 s into the container's life, no HEALTHY line and no RuntimeError in the log.

## Todo

- [x] `_launch_llama_server()` returns a supervised handle instead of dropping the `Popen`
- [x] Tee stdout/stderr: keep streaming the startup report to the Modal log AND retain a bounded ring buffer for the error
- [x] `_wait_until_ready()` aborts the moment `returncode is not None`; 600 s ceiling kept only for a process that is still alive
- [x] Distinguish the two poll failures that `except OSError: pass` currently conflates (bound-and-503 vs not-bound)
- [x] Post-ready watchdog kills the container on any exit
- [x] Classify permanent (CUDA OOM, bad GGUF, unsupported arch) vs transient load failures
- [x] Stop paying to fail twice: a permanent failure short-circuits the next cold start of the same parameter set
- [x] Tests: early exit detected, slow-but-alive load granted the full window, exit-after-ready handled

## Summary of Changes

New `tools/modal/supervisor.py` (stdlib only — `app.py` imports `modal`, which CI never
installs, so nothing testable can live there) holds the supervision:

- `launch()` keeps the `Popen` and starts a tee thread. stderr is merged into stdout and
  every byte is echoed onward, so llama.cpp's startup report — the KV cache size it
  ACTUALLY allocated, the only check on the solver's `kv_bytes_per_token` — still reaches
  the Modal log; the same bytes fill a 50-line ring buffer for the error.
- `wait_until_ready()` calls `poll()` before every probe and raises `LlamaServerExited`
  the moment `returncode is not None`. The 600 s ceiling is unchanged and is now only
  ever reached by a process that is still alive.
- `probe_health()` returns HEALTHY / LOADING / UNBOUND instead of a bool. `HTTPError` and
  `URLError` are both `OSError`, which is how "still loading" and "exited ten seconds
  ago" got swallowed by one clause; the timeout message now says which kind of stuck.
- `watch_after_ready()` waits on the child and `os._exit(70)`s the container when it
  dies. `sys.exit` would unwind one thread and leave Modal proxying to a closed port for
  the rest of `scaledown_window`. `@modal.exit` sets a flag first so an ordinary
  scaledown is not mistaken for a crash.
- `classify_exit()` splits permanent (CUDA OOM, KV cache that will not fit, bad GGUF,
  unsupported arch/quant) from transient (download, volume I/O). Silence and bare signals
  stay UNKNOWN, which never caches.
- A permanent failure DURING LOAD writes `/cache/load-failures/<key>.json` on the weights
  Volume (with an explicit `Volume.commit`, since the process is about to `os._exit`).
  `@modal.enter` reads it first, so the next cold start of that tuple costs container
  boot rather than download + load + poll. The key includes the GPU — every tier mounts
  the same Volume, and an L4 OOM says nothing about an H100.

`app.py` becomes wiring: `_bring_up()` / `_tear_down()`, `@modal.exit` on all seven tier
classes, and one `_GPU_*` constant per tier so the decorator and the sentinel key cannot
drift. `add_local_python_source("supervisor")` on the image, because Modal 1.x no longer
auto-mounts local modules.

47 new tests in `test_supervisor.py` (95 total in `tools/modal`, added to the CI list).
The clock and sleep are injected, so "the full 600 s window was granted" is asserted
exactly and costs nothing; the tee, the pipes and the pump thread are also proved against
real `subprocess` children.

### Deliberately not done

Issue #36 step 5 also asks for the model row to leave `ready` with the reason, visible to
the creator. The money half is done — the pool stops being cold-started. The database
half is not: nothing in the worker holds a credential that could write `custom_models`,
and giving one to a container that executes creator-supplied GGUF weights is a worse
trade than the bug. The reason reaches the outside as one greppable
`[serve] LOAD-FAILURE {json}` line for now. Recorded in `docs/HANDOFF.md` under
"Known-open, deliberately"; the stepper remediation hints (`ca-wcvm`) are its natural
home.
