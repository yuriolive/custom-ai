/**
 * runpod-client.js — minimal RunPod GraphQL client. Zero dependencies.
 *
 * SECURITY CONTRACT (non-negotiable, see docs/CONTRACTS.md):
 *   - RUNPOD_API_KEY is read from the environment ONLY. Never a CLI flag, never a file.
 *   - It is sent in the Authorization header, NEVER in a query string (URLs land in
 *     proxy logs, browser history and error reports).
 *   - `redact()` is applied to every string this module or its callers print or persist.
 *     Nothing that has touched the key reaches stdout or the state file unredacted.
 */

const KEY_SHAPED = /\b(rpa_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g;

/**
 * Redact the live API key plus anything that merely LOOKS like a key. Belt and braces:
 * exact-match redaction fails the moment a key arrives from an unexpected place.
 * @param {unknown} value
 * @param {string|undefined} apiKey
 */
export function redact(value, apiKey = process.env.RUNPOD_API_KEY) {
  let out = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (out === undefined) return out;
  if (apiKey && apiKey.length >= 4) {
    out = out.split(apiKey).join("[REDACTED:RUNPOD_API_KEY]");
  }
  out = out.replace(KEY_SHAPED, "[REDACTED:KEY_SHAPED]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, "$1[REDACTED]");
  out = out.replace(/([?&]api_key=)[^&\s"']+/gi, "$1[REDACTED]");
  return out;
}

/** Deep-clone an object with any key-shaped value replaced. Used before persisting state. */
export function redactObject(obj, apiKey = process.env.RUNPOD_API_KEY) {
  return JSON.parse(redact(JSON.stringify(obj), apiKey));
}

export class RunpodError extends Error {
  constructor(message, { code = "runpod_error", status = null, remediation = null, graphqlErrors = null } = {}) {
    super(redact(message));
    this.name = "RunpodError";
    this.code = code;
    this.status = status;
    this.remediation = remediation;
    this.graphqlErrors = graphqlErrors;
  }
}

export const DEFAULT_GRAPHQL_URL = "https://api.runpod.io/graphql";

/** Resolve the GraphQL base URL. Defaults from env so tests point at the fake. */
export function resolveGraphqlUrl(explicit) {
  return explicit || process.env.RUNPOD_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;
}

/**
 * Read the API key from env. `required:false` yields null so --dry-run works with no key,
 * which is the whole point: the payloads must be reviewable before anyone spends money.
 */
export function resolveApiKey({ required = true } = {}) {
  const key = process.env.RUNPOD_API_KEY;
  if (!key && required) {
    throw new RunpodError("RUNPOD_API_KEY is not set in the environment.", {
      code: "missing_api_key",
      remediation:
        "Export RUNPOD_API_KEY before running. It is read from the environment only — there is no flag for it, by design. Use --dry-run to review payloads without a key.",
    });
  }
  return key ?? null;
}

/**
 * Map RunPod's GraphQL error text onto a structured code + human remediation hint
 * (FR-DEP-036: failures store a structured runpod_error AND a remediation_hint).
 */
export function classifyError({ status, graphqlErrors }) {
  const text = (graphqlErrors ?? []).map((e) => e?.message ?? "").join(" | ").toLowerCase();

  if (status === 401 || status === 403 || /unauthor|invalid api key|authentication/.test(text)) {
    return {
      code: "auth_failed",
      remediation:
        "RunPod rejected the API key. Regenerate it at runpod.io > Settings > API Keys and re-export RUNPOD_API_KEY. The key is never written to the state file, so rotating it requires no cleanup here.",
    };
  }
  if (/quota|limit exceeded|insufficient funds|no longer available|out of capacity/.test(text)) {
    return {
      code: "quota_exhausted",
      remediation:
        "RunPod refused the resource on quota or capacity grounds. Check the account balance and the serverless endpoint quota, or re-run once capacity for this GPU type returns. Nothing was orphaned: any resource already created is recorded in the state file and `teardown.js` will remove it.",
    };
  }
  if (/gpu|not available in|no instances/.test(text)) {
    return {
      code: "gpu_unavailable",
      remediation:
        "The requested gpuIds are unavailable in the selected locations. Re-run once capacity returns, or pass an explicit --gpu-tier whose GPU is available.",
    };
  }
  if (status && status >= 500) {
    return { code: "runpod_unavailable", remediation: "RunPod returned a server error. Re-running is safe — provisioning is idempotent." };
  }
  return { code: "runpod_error", remediation: "Unclassified RunPod failure. Re-running is safe — provisioning is idempotent." };
}

/**
 * Issue one GraphQL request.
 * @param {{url?:string, apiKey?:string, query:string, variables?:object, operationName?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} opts
 */
export async function graphql({
  url,
  apiKey,
  query,
  variables = {},
  operationName,
  timeoutMs = 60_000,
  fetchImpl = fetch,
}) {
  const endpoint = resolveGraphqlUrl(url);
  const key = apiKey ?? resolveApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  let bodyText;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header, never a query param. See the security contract at the top of this file.
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, variables, operationName }),
      signal: controller.signal,
    });
    bodyText = await res.text();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new RunpodError(`RunPod GraphQL request timed out after ${timeoutMs} ms`, {
        code: "timeout",
        remediation: "Re-running is safe — provisioning is idempotent and reconciles against RunPod before creating anything.",
      });
    }
    throw new RunpodError(`RunPod GraphQL transport failure: ${err?.message ?? err}`, {
      code: "network_error",
      remediation: "Check connectivity to " + endpoint + " and re-run. Provisioning is idempotent.",
    });
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    const { code, remediation } = classifyError({ status: res.status, graphqlErrors: [{ message: bodyText }] });
    throw new RunpodError(
      `RunPod returned HTTP ${res.status} with a non-JSON body: ${bodyText.slice(0, 400)}`,
      { code, status: res.status, remediation },
    );
  }

  const graphqlErrors = Array.isArray(payload?.errors) ? payload.errors : null;
  if (graphqlErrors?.length || !res.ok) {
    const { code, remediation } = classifyError({ status: res.status, graphqlErrors: graphqlErrors ?? [] });
    const message =
      graphqlErrors?.map((e) => e?.message).filter(Boolean).join("; ") ||
      `HTTP ${res.status}`;
    throw new RunpodError(`RunPod ${operationName ?? "GraphQL"} failed: ${message}`, {
      code,
      status: res.status,
      remediation,
      graphqlErrors,
    });
  }

  return payload.data;
}

/**
 * Render a GraphQL document with its variables inlined, for --dry-run review.
 * This is presentation only — the wire body is always {query, variables}.
 */
export function materializeForReview(query, variables) {
  const render = (v, indent) => {
    const pad = " ".repeat(indent);
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => `${pad}  ${render(x, indent + 2)}`).join("\n")}\n${pad}]`;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      return `{\n${entries.map(([k, x]) => `${pad}  ${k}: ${render(x, indent + 2)}`).join("\n")}\n${pad}}`;
    }
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
  };
  return redact(`${query.trim()}\n\n# variables:\n${render(variables, 0)}`);
}
