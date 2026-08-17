/**
 * Thin Hugging Face Hub HTTP client. fetch + Web APIs only (Deno/Node alike).
 * Never logs a token; the Authorization header is built at call time and is
 * only attached to requests aimed at the configured endpoint.
 */

import type { HfFile } from "../../shared/types.ts";

export const HF_ENDPOINT = "https://huggingface.co";

export interface HfClientOptions {
  endpoint?: string;
  hfToken?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface HfResponse<T> {
  status: number;
  body: T | null;
  /** Non-null when the request failed or the body was not usable. */
  error: string | null;
}

function authHeaders(opts: HfClientOptions): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (opts.hfToken) h.Authorization = `Bearer ${opts.hfToken}`;
  return h;
}

export interface HfModelInfo {
  id?: string;
  sha?: string;
  private?: boolean;
  gated?: false | "auto" | "manual" | string;
  library_name?: string | null;
  pipeline_tag?: string | null;
  siblings?: { rfilename: string; size?: number }[];
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export async function getModelInfo(
  slug: string,
  opts: HfClientOptions = {},
): Promise<HfResponse<HfModelInfo>> {
  const base = opts.endpoint ?? HF_ENDPOINT;
  const url = `${base}/api/models/${slug}`;
  return await getJson<HfModelInfo>(url, opts);
}

interface HfTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  lfs?: { size?: number };
}

/**
 * `/tree/{revision}?recursive=true`. Follows RFC-5988 `rel="next"` pages —
 * the tree endpoint caps at 1000 entries and big GGUF repos exceed it.
 */
export async function listRepoFiles(
  slug: string,
  revision: string,
  opts: HfClientOptions = {},
): Promise<HfResponse<HfFile[]>> {
  const base = opts.endpoint ?? HF_ENDPOINT;
  let url: string | null =
    `${base}/api/models/${slug}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`;
  const files: HfFile[] = [];
  let status = 0;
  let pages = 0;

  while (url && pages < 50) {
    pages++;
    const doFetch = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, { headers: authHeaders(opts), signal: opts.signal });
    } catch (err) {
      return { status, body: null, error: `tree request failed: ${errText(err)}` };
    }
    status = res.status;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status, body: null, error: `tree request returned HTTP ${res.status}` };
    }
    let page: HfTreeEntry[];
    try {
      page = (await res.json()) as HfTreeEntry[];
    } catch (err) {
      return { status, body: null, error: `tree response was not JSON: ${errText(err)}` };
    }
    if (!Array.isArray(page)) {
      return { status, body: null, error: "tree response was not an array" };
    }
    for (const e of page) {
      if (e.type !== "file") continue;
      files.push({ path: e.path, sizeBytes: e.lfs?.size ?? e.size ?? 0 });
    }
    url = nextLink(res.headers.get("link") ?? res.headers.get("Link"));
  }
  return { status, body: files, error: null };
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/** Raw file URL for a repo file at a revision. */
export function resolveUrl(
  slug: string,
  revision: string,
  path: string,
  endpoint = HF_ENDPOINT,
): string {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `${endpoint}/${slug}/resolve/${encodeURIComponent(revision)}/${segments}`;
}

export async function getJson<T>(
  url: string,
  opts: HfClientOptions = {},
): Promise<HfResponse<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: authHeaders(opts), signal: opts.signal });
  } catch (err) {
    return { status: 0, body: null, error: `request failed: ${errText(err)}` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, body: null, error: `HTTP ${res.status}` };
  }
  try {
    return { status: res.status, body: (await res.json()) as T, error: null };
  } catch (err) {
    return { status: res.status, body: null, error: `response was not JSON: ${errText(err)}` };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
