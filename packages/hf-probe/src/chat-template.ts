/**
 * Chat-template tool-support detection — FR-TOOL-003.
 *
 * WHY A TEMPLATE READ AND NOT A LIVE PROBE. llama.cpp serves tools by running
 * the model's OWN Jinja chat template under `--jinja`. A template with no tool
 * handling does not fail: it renders the conversation and ignores `tools`
 * entirely, and the model answers in prose. The client's tool loop then parses a
 * successful turn that made no call — the failure mode FR-TOOL-002 calls the
 * worst one, because nothing anywhere reports an error.
 *
 * A live "call this tool" probe cannot decide this either: a model is allowed to
 * answer without calling, so a negative result proves nothing. The template is
 * the artifact that either can or cannot render a tool definition, so it is what
 * gets read.
 *
 * Web APIs only (fetch, TextDecoder) — this runs in a Next server route today
 * and must stay importable from Deno.
 */

import { CHAT_TEMPLATE_KEY, readGgufChatTemplate } from "./gguf.ts";
import { getJson, getText, HF_ENDPOINT, resolveUrl, type HfClientOptions } from "./hf.ts";

/** Standalone template file — the current Hub convention. */
export const CHAT_TEMPLATE_FILE = "chat_template.jinja";
/** Where the template lived before that, and still does on most repos. */
export const TOKENIZER_CONFIG_FILE = "tokenizer_config.json";

/**
 * A template that can render tool definitions has to REFERENCE them, and there
 * are only so many spellings in circulation:
 *
 *   `{%- if tools %}`            Qwen, Llama 3.x, most Hub templates
 *   `{{ tools | tojson }}`       same, the rendering half
 *   `[AVAILABLE_TOOLS]`          Mistral / Mixtral
 *   `message.tool_calls`         the assistant-side replay, present in all of them
 *
 * Matching the bare word `tools` is deliberately loose. The two error directions
 * are not symmetric: a false positive forwards `tools` to a model that ignores
 * them, which is the behavior of every gateway that has no flag at all; a false
 * negative returns 400 for a model that works. So this leans permissive, and
 * `role == "tool"` alone — a template that consumes tool RESULTS but cannot
 * declare tools — deliberately does not match.
 */
const TOOL_MARKERS: readonly RegExp[] = [/\btools\b/i, /\btool_calls?\b/i];

/**
 * Does this chat template declare tool support?
 *
 * Returns null for a template that is absent or blank — "unknown", which is not
 * the same answer as "no" and must not collapse into it downstream.
 */
export function detectToolSupport(template: string | null | undefined): boolean | null {
  if (typeof template !== "string") return null;
  const trimmed = template.trim();
  if (trimmed.length === 0) return null;
  return TOOL_MARKERS.some((re) => re.test(trimmed));
}

/** Where the template was read from. Recorded because it decides how much to trust. */
export type ToolSupportSource = "chat_template_file" | "tokenizer_config" | "gguf_header";

export interface ToolSupportResult {
  /** true / false measured; null when no template could be read at all. */
  supported: boolean | null;
  source: ToolSupportSource | null;
  /** Why `supported` is null. Advisory — provisioning proceeds either way. */
  error?: string;
}

export interface ToolSupportOptions extends HfClientOptions {
  revision?: string;
  endpoint?: string;
  /**
   * Repo file paths, from the probe that already listed them. Passing them
   * avoids a second /tree call and lets this skip fetches that would 404.
   */
  files?: string[];
  /**
   * Repo-relative GGUF file to read `tokenizer.chat_template` out of, used only
   * when the repo ships no template file of its own. This is the ONLY path that
   * works for a llama.cpp-native repo, which typically contains nothing but
   * .gguf files and a README.
   */
  ggufFile?: string | null;
  /** Byte ceiling for the GGUF read. See readGgufChatTemplate. */
  maxBytes?: number;
}

/**
 * `tokenizer_config.chat_template` is either a string or — on repos that predate
 * the split into `chat_template.jinja` — a list of named templates, where the
 * tool-calling variant is a SEPARATE entry. Both forms are folded to one string:
 * any entry declaring tools makes the model tool-capable.
 */
function templateFromTokenizerConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const raw = (config as { chat_template?: unknown }).chat_template;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return joinNamedTemplates(raw);
  return null;
}

/**
 * Fold `[{name, template}, …]` into one string. The NAME is folded in too, not
 * just the body: an entry named `tool_use` is itself a declaration of tool
 * support even if its template spells the capability some way we do not match.
 */
function joinNamedTemplates(entries: unknown[]): string | null {
  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { name?: unknown; template?: unknown };
    if (typeof e.name === "string") parts.push(e.name);
    if (typeof e.template === "string") parts.push(e.template);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Read whichever chat template this repo actually has, and decide.
 *
 * Cheapest source first — the two repo files are a few KB; the GGUF key sits
 * behind several MB of tokenizer arrays and is tried only when neither exists.
 *
 * Never throws and never rejects a deployment: an unreadable template yields
 * `{supported: null}`, which the gateway forwards.
 */
export async function resolveToolSupport(
  slug: string,
  opts: ToolSupportOptions = {},
): Promise<ToolSupportResult> {
  const where = { slug, revision: opts.revision ?? "main", endpoint: opts.endpoint ?? HF_ENDPOINT };
  // With no file list, try both files: a 404 costs one request and is not an error.
  const has = (path: string) => opts.files === undefined || opts.files.includes(path);
  const gguf = opts.ggufFile;

  const sources: Array<() => Promise<ToolSupportResult>> = [];
  if (has(CHAT_TEMPLATE_FILE)) sources.push(() => fromTemplateFile(where, opts));
  if (has(TOKENIZER_CONFIG_FILE)) sources.push(() => fromTokenizerConfig(where, opts));
  if (gguf) sources.push(() => fromGgufHeader(where, gguf, opts));

  const errors: string[] = [];
  for (const attempt of sources) {
    const result = await attempt();
    // A decided answer stops the search: the cheaper source is also the more
    // specific one, and a repo that ships a template file means it.
    if (result.supported !== null) return result;
    if (result.error) errors.push(result.error);
  }

  return {
    supported: null,
    source: null,
    error: errors.length > 0 ? errors.join("; ") : "no chat template found in this repository",
  };
}

/** Repo slug, revision and endpoint — the three things every source needs. */
interface RepoRef {
  slug: string;
  revision: string;
  endpoint: string;
}

/** Undecided, with the reason. Never a rejection: the caller proceeds either way. */
function unknown(error: string | undefined): ToolSupportResult {
  return error === undefined
    ? { supported: null, source: null }
    : { supported: null, source: null, error };
}

async function fromTemplateFile(at: RepoRef, opts: ToolSupportOptions): Promise<ToolSupportResult> {
  const url = resolveUrl(at.slug, at.revision, CHAT_TEMPLATE_FILE, at.endpoint);
  const res = await getText(url, opts);
  const supported = detectToolSupport(res.body);
  if (supported !== null) return { supported, source: "chat_template_file" };
  return unknown(res.error ? `${CHAT_TEMPLATE_FILE}: ${res.error}` : undefined);
}

async function fromTokenizerConfig(
  at: RepoRef,
  opts: ToolSupportOptions,
): Promise<ToolSupportResult> {
  const url = resolveUrl(at.slug, at.revision, TOKENIZER_CONFIG_FILE, at.endpoint);
  const res = await getJson<unknown>(url, opts);
  const supported = detectToolSupport(templateFromTokenizerConfig(res.body));
  if (supported !== null) return { supported, source: "tokenizer_config" };
  return unknown(res.error ? `${TOKENIZER_CONFIG_FILE}: ${res.error}` : undefined);
}

async function fromGgufHeader(
  at: RepoRef,
  file: string,
  opts: ToolSupportOptions,
): Promise<ToolSupportResult> {
  const read = await readGgufChatTemplate(resolveUrl(at.slug, at.revision, file, at.endpoint), {
    fetchImpl: opts.fetchImpl,
    hfToken: opts.hfToken,
    signal: opts.signal,
    maxBytes: opts.maxBytes,
  });
  if (!read.ok) return unknown(`${file}: ${read.error}`);
  const supported = detectToolSupport(read.template);
  if (supported !== null) return { supported, source: "gguf_header" };
  return unknown(`${CHAT_TEMPLATE_KEY} was empty`);
}
