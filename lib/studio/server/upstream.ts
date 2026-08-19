import "server-only";

/**
 * The upstream half of provisioning: building the pool reference, and the
 * smoke test that measures what the pool actually delivers (FR-DEP-052).
 *
 * ── There is no "create endpoint" API call here, and that is correct ────────
 *
 * MVP-0 serves from Modal, and on Modal a model is not a resource that gets
 * created and later destroyed — it is a set of class parameters that selects an
 * autoscaled container pool on first request (tools/modal/README.md). One
 * `modal deploy` publishes the app; adding a model is a database row plus a
 * first request. So "Creating endpoint" resolves to computing the opaque,
 * provider-shaped reference that names the pool, and there is genuinely nothing
 * to roll back if a later step fails.
 *
 * The RunPod shape is retained because `upstream_endpoint_ref` is provider-
 * shaped and the gateway builds two different URLs from it — but RunPod
 * endpoint CREATION (PRD §4.3.4) is not implemented, and this module does not
 * pretend otherwise: it uses the one manually provisioned endpoint named by
 * RUNPOD_ENDPOINT_ID (CONTRACTS.md §Environment, "MVP-0: one manually
 * provisioned endpoint") and fails with a specific hint when that is absent.
 */

export type UpstreamProvider = "modal" | "runpod";

export type UpstreamConfig = {
  provider: UpstreamProvider;
  baseUrl: string;
  runpodApiKey: string;
  runpodEndpointId: string;
  modalKey: string;
  modalSecret: string;
};

/**
 * Trailing `/` removal without a regex.
 *
 * `/\/+$/` looks harmless and is not: an anchored `+` makes the engine retry
 * from every position in a run of slashes, so the match is quadratic in a
 * pathological input. This value comes from the environment rather than a
 * request, so it was never reachable — but a linear loop costs nothing and
 * removes the question.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/**
 * `mock` is a documented value of UPSTREAM_PROVIDER (.env.example) and speaks
 * the RunPod wire shape, so it maps to `runpod` exactly as the gateway's own
 * `parseUpstreamProvider` does. Keeping the two in step matters: a model
 * provisioned with a Modal-shaped reference and served through a RunPod-shaped
 * URL 404s at the upstream and reads as a cold-start timeout from the client.
 */
export function readUpstreamConfig(): UpstreamConfig {
  const raw = process.env.UPSTREAM_PROVIDER?.trim().toLowerCase();
  return {
    provider: raw === "modal" ? "modal" : "runpod",
    baseUrl: stripTrailingSlashes(process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:8787"),
    runpodApiKey: process.env.RUNPOD_API_KEY ?? "",
    runpodEndpointId: process.env.RUNPOD_ENDPOINT_ID ?? "",
    modalKey: process.env.MODAL_KEY ?? "",
    modalSecret: process.env.MODAL_SECRET ?? "",
  };
}

export type PoolSpec = {
  hfRepoSlug: string;
  /** The SPECIFIC file llama.cpp loads. vLLM resolves a repo (FR-DEP-061). */
  variantFile: string;
  contextLength: number;
  /** llama.cpp `--parallel`: the worker's slot count. */
  parallel: number;
};

export type RefResult = { ok: true; ref: string } | { ok: false; message: string; hint: string };

/**
 * The opaque reference the gateway splices into the provider's URL template.
 *
 * On Modal the query string is not decoration — it is what selects the pool for
 * a given (repo, file, ctx_size, parallel) tuple, and a request without it
 * routes to a pool with unbound parameters that never serves.
 */
export function buildUpstreamRef(config: UpstreamConfig, spec: PoolSpec): RefResult {
  if (config.provider === "modal") {
    const query = new URLSearchParams({
      model_repo: spec.hfRepoSlug,
      model_file: spec.variantFile,
      ctx_size: String(spec.contextLength),
      parallel: String(spec.parallel),
    }).toString();
    return { ok: true, ref: query };
  }

  if (!config.runpodEndpointId) {
    return {
      ok: false,
      message: "No upstream endpoint is configured for this deployment.",
      hint:
        "RUNPOD_ENDPOINT_ID is not set. MVP-0 serves from one manually provisioned endpoint; " +
        "set it in the environment, or set UPSTREAM_PROVIDER=modal to use a Modal container pool.",
    };
  }
  return { ok: true, ref: config.runpodEndpointId };
}

// ─── Smoke test (FR-DEP-052) ────────────────────────────────────────────────

export type SmokeResult =
  | {
      ok: true;
      /** MEASURED, over >= 64 generated tokens. Never a prediction. */
      tokensPerSecond: number;
      completionTokens: number;
      ttftMs: number;
      durationMs: number;
      /** True when the count came from the worker's own usage object. */
      usageFromUpstream: boolean;
    }
  | { ok: false; message: string; hint: string };

/** FR-DEP-052 requires the measurement to span at least 64 generated tokens. */
const SMOKE_MIN_TOKENS = 64;
const SMOKE_MAX_TOKENS = 96;

/**
 * What actually went wrong, in the upstream's own words where there are any.
 *
 * A timeout and a refused connection have different remedies, and the abort
 * case has to be distinguished FIRST: an AbortError's own message is
 * "This operation was aborted", which tells the creator nothing about the
 * cold-start budget that actually elapsed.
 */
function smokeFailureMessage(aborted: boolean, cause: unknown, timeoutMs: number): string {
  if (aborted) {
    return `The worker produced no complete response within ${Math.round(timeoutMs / 1000)}s.`;
  }
  if (cause instanceof Error) return cause.message;
  return "The smoke test could not reach the worker.";
}

function upstreamUrl(config: UpstreamConfig, ref: string): string {
  if (config.provider === "modal") {
    const query = ref.replace(/^[?]+/, "");
    return query
      ? `${config.baseUrl}/v1/chat/completions?${query}`
      : `${config.baseUrl}/v1/chat/completions`;
  }
  return `${config.baseUrl}/v2/${ref}/openai/v1/chat/completions`;
}

/**
 * Generate real tokens against the pool and measure the rate.
 *
 * This calls the UPSTREAM directly rather than the gateway, deliberately: the
 * gateway requires an API key and a model already in `ready`, so routing the
 * readiness check through it is circular. Billing is not involved — no
 * `usage_transactions` row exists for a smoke test, and none should: the
 * platform is paying for this, not the creator.
 *
 * Token counting follows CONTRACTS.md §Money: `completion_tokens` from the
 * worker covers BOTH `delta.content` and `delta.reasoning_content`, and the
 * chunk-count fallback below counts a chunk carrying either. Counting only
 * `content` on a reasoning model under-counts by up to 89%, and here that would
 * under-report throughput and trigger a pointless tier escalation.
 */
export async function smokeTest(
  config: UpstreamConfig,
  ref: string,
  servedModelName: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SmokeResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (config.provider === "modal") {
    // Only sent when configured: an endpoint deployed without
    // `requires_proxy_auth` accepts the call unauthenticated.
    if (config.modalKey && config.modalSecret) {
      headers["Modal-Key"] = config.modalKey;
      headers["Modal-Secret"] = config.modalSecret;
    }
  } else if (config.runpodApiKey) {
    headers.authorization = `Bearer ${config.runpodApiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const started = Date.now();
  let firstTokenAt: number | null = null;
  let chunkTokens = 0;
  let usageCompletion: number | null = null;

  try {
    const response = await fetch(upstreamUrl(config, ref), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: servedModelName,
        messages: [
          {
            role: "user",
            content: "Count from one to eighty, one number per line, with no other words.",
          },
        ],
        stream: true,
        // The gateway injects this unconditionally and so does this path:
        // vLLM emits no usage without it, and llama.cpp ignores it.
        stream_options: { include_usage: true },
        max_tokens: SMOKE_MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        message: `The worker returned HTTP ${response.status}. ${detail.slice(0, 400)}`.trim(),
        hint: hintForStatus(response.status, config),
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (typeof parsed !== "object" || parsed === null) continue;
          const chunk = parsed as {
            choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[];
            usage?: { completion_tokens?: unknown };
          };

          const usage = chunk.usage?.completion_tokens;
          if (typeof usage === "number" && usage > 0) usageCompletion = usage;

          const delta = chunk.choices?.[0]?.delta;
          const produced =
            (typeof delta?.content === "string" && delta.content.length > 0) ||
            (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0);
          if (produced) {
            firstTokenAt ??= Date.now();
            chunkTokens += 1;
          }
        }
      }
    }
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return {
      ok: false,
      message: smokeFailureMessage(aborted, cause, opts.timeoutMs),
      hint: aborted
        ? "This is usually a cold start that exceeded the model's budget, or a pool that is not serving. " +
          "Check that the upstream worker is deployed and that UPSTREAM_BASE_URL points at it."
        : `The upstream at ${config.baseUrl} did not answer. Check UPSTREAM_BASE_URL and that the worker is running.`,
    };
  } finally {
    clearTimeout(timer);
  }

  const finished = Date.now();
  const completionTokens = usageCompletion ?? chunkTokens;

  if (completionTokens < SMOKE_MIN_TOKENS) {
    return {
      ok: false,
      message: `The worker produced only ${completionTokens} tokens; at least ${SMOKE_MIN_TOKENS} are needed to measure throughput.`,
      hint:
        "A short response usually means the worker hit an internal error mid-stream, or the model " +
        "stopped early. The measured speed on this model card must come from a real generation, so " +
        "the deployment is not marked ready on a partial one.",
    };
  }

  // Decode rate, not wall-clock rate: the interval from the FIRST token to the
  // last is what "tokens per second per stream" means. Including time-to-first-
  // token would fold a 23 s cold start into the rate and report ~4 tok/s for a
  // worker that decodes at 45.
  const decodeMs = Math.max(1, finished - (firstTokenAt ?? started));

  return {
    ok: true,
    tokensPerSecond: (completionTokens * 1000) / decodeMs,
    completionTokens,
    ttftMs: (firstTokenAt ?? finished) - started,
    durationMs: finished - started,
    usageFromUpstream: usageCompletion !== null,
  };
}

/** FR-STU-008: the verbatim upstream failure, plus what to do about it. */
function hintForStatus(status: number, config: UpstreamConfig): string {
  if (status === 401 || status === 403) {
    return config.provider === "modal"
      ? "The Modal endpoint rejected the credentials. MODAL_KEY / MODAL_SECRET must be a PROXY token pair (wk-… / ws-…), minted with `modal workspace proxy-tokens create`."
      : "The upstream rejected the credentials. Check RUNPOD_API_KEY.";
  }
  if (status === 404) {
    return "The upstream has no pool at that reference. On Modal the query string selects the container pool, so a repo or file name that does not match a deployed class parameter set 404s.";
  }
  if (status === 429) {
    return "The upstream is rate limiting. Retry the deployment in a few minutes.";
  }
  if (status >= 500) {
    return "The worker failed to start or crashed while loading weights. The most common cause is a variant too large for the resolved GPU, or a gated repo whose token does not grant access at pull time.";
  }
  return "The worker rejected the request. The message above is the upstream's own.";
}
