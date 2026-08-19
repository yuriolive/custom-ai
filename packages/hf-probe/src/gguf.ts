/**
 * GGUF key-value header reader — FR-DEP-043 path 2.
 *
 * GGUF-only repos ship NO config.json, so this is the ONLY source of attention
 * geometry for the MVP's own target model. It is a first-class path, not a
 * fallback: if the header cannot be parsed we return an ERROR. We never guess a
 * memory profile (§4.3.3.5, "Architecture unknown -> reject at form time").
 *
 * Layout (v2/v3, little-endian):
 *   magic "GGUF" | uint32 version | uint64 tensor_count | uint64 kv_count
 *   then kv_count pairs of: string key | uint32 type | value
 * v1 used uint32 for the counts and string lengths; handled as a best effort.
 *
 * Only the first ~2 MB of the file is fetched, via an HTTP Range request.
 * A full download is never required and is actively guarded against.
 *
 * Web APIs only (fetch, DataView, TextDecoder) — runs unchanged on Deno.
 */

import type { ModelArchitecture } from "../../shared/types.ts";

// ─── value types ────────────────────────────────────────────────────────────

const T_UINT8 = 0;
const T_INT8 = 1;
const T_UINT16 = 2;
const T_INT16 = 3;
const T_UINT32 = 4;
const T_INT32 = 5;
const T_FLOAT32 = 6;
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;
const T_UINT64 = 10;
const T_INT64 = 11;
const T_FLOAT64 = 12;

const FIXED_WIDTH: Record<number, number> = {
  [T_UINT8]: 1,
  [T_INT8]: 1,
  [T_UINT16]: 2,
  [T_INT16]: 2,
  [T_UINT32]: 4,
  [T_INT32]: 4,
  [T_FLOAT32]: 4,
  [T_BOOL]: 1,
  [T_UINT64]: 8,
  [T_INT64]: 8,
  [T_FLOAT64]: 8,
};

export type GgufValue = number | bigint | string | boolean | GgufValue[];

/** Thrown when the fetched prefix ends mid-structure. Not a parse failure. */
class TruncatedError extends Error {
  constructor() {
    super("gguf header prefix truncated");
    this.name = "TruncatedError";
  }
}

class Cursor {
  readonly view: DataView;
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get length(): number {
    return this.buf.byteLength;
  }
  private need(n: number): number {
    const at = this.pos;
    if (n < 0 || at + n > this.buf.byteLength) throw new TruncatedError();
    this.pos = at + n;
    return at;
  }
  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }
  f64(): number {
    return this.view.getFloat64(this.need(8), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.need(8), true);
  }
  i64(): bigint {
    return this.view.getBigInt64(this.need(8), true);
  }
  skip(n: number): void {
    this.need(n);
  }
  bytes(n: number): Uint8Array {
    return this.buf.subarray(this.need(n), this.pos);
  }
  magic(): string {
    return String.fromCharCode(...this.bytes(4));
  }
}

const DECODER = new TextDecoder("utf-8", { fatal: false });

/** Elements of a huge array we keep; the rest is skipped, never allocated. */
const MAX_KEPT_ARRAY_ELEMENTS = 64;

function readLength(c: Cursor, wide: boolean): number {
  if (!wide) return c.u32();
  const n = c.u64();
  if (n > 0x7fff_ffffn) throw new TruncatedError();
  return Number(n);
}

function readString(c: Cursor, wide: boolean): string {
  const len = readLength(c, wide);
  return DECODER.decode(c.bytes(len));
}

function readValue(c: Cursor, type: number, wide: boolean): GgufValue {
  switch (type) {
    case T_UINT8:
      return c.u8();
    case T_INT8:
      return c.i8();
    case T_UINT16:
      return c.u16();
    case T_INT16:
      return c.i16();
    case T_UINT32:
      return c.u32();
    case T_INT32:
      return c.i32();
    case T_FLOAT32:
      return c.f32();
    case T_BOOL:
      return c.u8() !== 0;
    case T_STRING:
      return readString(c, wide);
    case T_UINT64:
      return c.u64();
    case T_INT64:
      return c.i64();
    case T_FLOAT64:
      return c.f64();
    case T_ARRAY: {
      const elemType = c.u32();
      const count = readLength(c, wide);
      // Tokenizer arrays are ~150k strings. Advance over them; keep a head.
      const kept: GgufValue[] = [];
      const width = FIXED_WIDTH[elemType];
      if (width !== undefined) {
        const keep = Math.min(count, MAX_KEPT_ARRAY_ELEMENTS);
        for (let i = 0; i < keep; i++) kept.push(readValue(c, elemType, wide));
        c.skip((count - keep) * width);
      } else if (elemType === T_STRING) {
        for (let i = 0; i < count; i++) {
          // Past the head, seek over the length-prefixed bytes instead of
          // decoding them. A 250k-token vocabulary is otherwise 250k discarded
          // TextDecoder calls, which is most of the cost of reading a header
          // deep enough to reach tokenizer.chat_template.
          if (i < MAX_KEPT_ARRAY_ELEMENTS) kept.push(readString(c, wide));
          else c.skip(readLength(c, wide));
        }
      } else {
        // Nested arrays are not emitted by any known writer.
        throw new Error(`unsupported gguf array element type ${elemType}`);
      }
      return kept;
    }
    default:
      throw new Error(`unsupported gguf value type ${type}`);
  }
}

export interface GgufHeader {
  version: number;
  tensorCount: number;
  kvCount: number;
  kv: Record<string, GgufValue>;
  /** True when the fetched prefix ran out before the last KV pair. */
  truncated: boolean;
}

const KEYS_FOR = (arch: string) => ({
  blockCount: `${arch}.block_count`,
  headCount: `${arch}.attention.head_count`,
  headCountKv: `${arch}.attention.head_count_kv`,
  embeddingLength: `${arch}.embedding_length`,
  contextLength: `${arch}.context_length`,
  keyLength: `${arch}.attention.key_length`,
  expertCount: `${arch}.expert_count`,
  expertUsedCount: `${arch}.expert_used_count`,
  // Hybrid attention/SSM keys. Absent on a plain transformer.
  fullAttentionInterval: `${arch}.full_attention_interval`,
  nextnPredictLayers: `${arch}.nextn_predict_layers`,
  ssmStateSize: `${arch}.ssm.state_size`,
  ssmInnerSize: `${arch}.ssm.inner_size`,
  ssmGroupCount: `${arch}.ssm.group_count`,
  ssmConvKernel: `${arch}.ssm.conv_kernel`,
});

/**
 * How many blocks actually hold a KV cache that GROWS with context.
 *
 * Exactly which blocks are counted, and why:
 *
 *  - MTP / next-token-prediction blocks are EXCLUDED. `{arch}.nextn_predict_layers`
 *    counts speculative-decode heads appended after the transformer stack. They
 *    are not executed on the normal decode path (llama.cpp does not run them in
 *    the MVP configuration) and hold no KV for the served sequence. On the MVP
 *    target this takes 65 blocks down to 64 — and the `noMTP` family of the same
 *    repo ships exactly those 64 blocks, which is the cross-check that this is
 *    the right subtraction.
 *
 *  - Of the remaining blocks, one in `fullAttentionInterval` is a full-attention
 *    block; the rest are linear/SSM blocks whose per-sequence state is CONSTANT
 *    in context length and therefore belongs in the `ssm` term, not the KV term.
 *    We take the FLOOR, because both conventions in use place the attention block
 *    at the END of each group (layer i is full attention iff (i+1) % interval == 0)
 *    or at the START (i % interval == 0); a trailing partial group contains an
 *    attention block under the second convention only, and counting one that may
 *    not exist over-sizes KV. Floor and ceil differ by at most one layer.
 *
 *  - With no interval key at all the model is a plain transformer and every
 *    non-MTP block holds KV, so this returns nLayers unchanged.
 *
 * MVP target: 65 blocks, 1 MTP block, interval 4 -> floor(64 / 4) = 16.
 * The `noMTP` family: 64 blocks, 0 MTP, interval 4 -> floor(64 / 4) = 16.
 * Both families agree, which is the result the DB side already assumes.
 */
export function deriveAttentionLayers(
  nLayers: number,
  fullAttentionInterval: number | null,
  mtpLayers: number,
): number {
  const core = Math.max(1, nLayers - Math.max(0, mtpLayers));
  if (fullAttentionInterval === null || fullAttentionInterval <= 1) return core;
  return Math.max(1, Math.floor(core / fullAttentionInterval));
}

/**
 * Parse a GGUF header out of a byte prefix.
 *
 * We read every KV pair we can and record `truncated` if the prefix runs out.
 * We deliberately do NOT stop as soon as the four mandatory keys are seen:
 * `{arch}.attention.key_length` is written after them, and on Qwen3 head_dim
 * is decoupled from hidden_size/head_count (128, not 5120/24=213). Stopping
 * early silently produced a wrong head_dim and would have mis-sized every KV
 * cache estimate. Truncation is tolerated instead: llama.cpp writes the whole
 * architecture block before the tokenizer arrays, so a 2 MB prefix gets it all.
 */
export function parseGgufHeader(bytes: Uint8Array): GgufHeader {
  const c = new Cursor(bytes);
  const magic = c.magic();
  if (magic !== "GGUF") throw new Error(`not a GGUF file (magic ${JSON.stringify(magic)})`);
  const version = c.u32();
  if (version < 1 || version > 3) throw new Error(`unsupported GGUF version ${version}`);
  const wide = version >= 2;

  const tensorCount = Number(wide ? c.u64() : BigInt(c.u32()));
  const kvCount = Number(wide ? c.u64() : BigInt(c.u32()));
  if (!Number.isFinite(kvCount) || kvCount < 0 || kvCount > 100_000) {
    throw new Error(`implausible GGUF metadata_kv_count ${kvCount}`);
  }

  const kv: Record<string, GgufValue> = {};
  let truncated = false;
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = readString(c, wide);
      const type = c.u32();
      kv[key] = readValue(c, type, wide);
    }
  } catch (err) {
    if (err instanceof TruncatedError) truncated = true;
    else throw err;
  }
  return { version, tensorCount, kvCount, kv, truncated };
}

function asInt(v: GgufValue | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  return null;
}

export type GgufArchitectureResult =
  | { ok: true; architecture: ModelArchitecture; header: GgufHeader; bytesRead: number }
  | { ok: false; error: string; bytesRead: number };

/**
 * Turn a parsed header into the solver's ModelArchitecture, or explain why not.
 */
export function architectureFromHeader(header: GgufHeader): GgufArchitectureResult {
  const kv = header.kv;
  const arch = kv["general.architecture"];
  if (typeof arch !== "string") {
    return {
      ok: false,
      bytesRead: 0,
      error: header.truncated
        ? "GGUF header prefix ended before general.architecture was read"
        : "GGUF header has no general.architecture key",
    };
  }
  const k = KEYS_FOR(arch);
  const nLayers = asInt(kv[k.blockCount]);
  const nAttentionHeads = asInt(kv[k.headCount]);
  const nKvHeadsRaw = asInt(kv[k.headCountKv]);
  const hiddenSize = asInt(kv[k.embeddingLength]);
  const contextLength = asInt(kv[k.contextLength]);
  const keyLength = asInt(kv[k.keyLength]);
  const fullAttentionInterval = asInt(kv[k.fullAttentionInterval]);
  const mtpLayers = asInt(kv[k.nextnPredictLayers]) ?? 0;

  const missing: string[] = [];
  if (nLayers === null) missing.push(k.blockCount);
  if (nAttentionHeads === null) missing.push(k.headCount);
  if (hiddenSize === null) missing.push(k.embeddingLength);
  // head_count_kv is optional in the GGUF spec and defaults to head_count
  // (i.e. plain MHA). Absent is not the same as unknown.
  if (missing.length > 0) {
    return {
      ok: false,
      bytesRead: 0,
      error:
        `GGUF header missing required key(s): ${missing.join(", ")}` +
        (header.truncated ? " (header prefix was truncated)" : ""),
    };
  }
  const nKvHeads = nKvHeadsRaw ?? nAttentionHeads!;
  // head_dim is NOT always hidden_size / head_count: Qwen3 decouples them
  // (5120 / 24 = 213.3, actual head_dim 128). Use key_length when present, and
  // refuse the fallback when it does not divide evenly rather than emit a
  // head_dim that would mis-size every KV-cache estimate downstream.
  let headDim: number;
  if (keyLength !== null) {
    headDim = keyLength;
  } else if ((hiddenSize! % nAttentionHeads!) === 0) {
    headDim = hiddenSize! / nAttentionHeads!;
  } else {
    return {
      ok: false,
      bytesRead: 0,
      error:
        `cannot derive head_dim: ${k.keyLength} is absent and ${k.embeddingLength} ` +
        `(${hiddenSize}) is not divisible by ${k.headCount} (${nAttentionHeads})` +
        (header.truncated ? "; the header prefix was truncated" : ""),
    };
  }
  if (!Number.isFinite(headDim) || headDim <= 0) {
    return { ok: false, bytesRead: 0, error: "GGUF header yielded a non-positive head_dim" };
  }
  return {
    ok: true,
    bytesRead: 0,
    header,
    architecture: {
      nLayers: nLayers!,
      nAttentionLayers: deriveAttentionLayers(nLayers!, fullAttentionInterval, mtpLayers),
      fullAttentionInterval,
      nKvHeads,
      nAttentionHeads: nAttentionHeads!,
      hiddenSize: hiddenSize!,
      headDim,
      maxPositionEmbeddings: contextLength,
      ssm: ssmFromHeader(kv, k),
      // Raw, never validated against an allowlist: the MVP's own target reports
      // "qwen35", which no allowlist written today would contain.
      architecture: arch,
      source: "gguf-header",
    },
  };
}

/**
 * `{arch}.ssm.*` -> the constant per-sequence state geometry, or null when the
 * model has no SSM blocks at all.
 *
 * state_size, inner_size and conv_kernel are required: together they are what
 * the per-sequence state costs. group_count defaults to 1 when absent, which is
 * not a guess — Mamba-1 has no groups and is mathematically single-group; only
 * Mamba-2-style architectures emit the key.
 */
function ssmFromHeader(
  kv: Record<string, GgufValue>,
  k: ReturnType<typeof KEYS_FOR>,
): ModelArchitecture["ssm"] {
  const stateSize = asInt(kv[k.ssmStateSize]);
  const innerSize = asInt(kv[k.ssmInnerSize]);
  const convKernel = asInt(kv[k.ssmConvKernel]);
  if (stateSize === null || innerSize === null || convKernel === null) return null;
  return {
    stateSize,
    innerSize,
    groupCount: asInt(kv[k.ssmGroupCount]) ?? 1,
    convKernel,
  };
}

/** Expert counts, when the model is MoE (FR-DEP-044). */
export function moeFromHeader(
  header: GgufHeader,
): { expertCount: number; expertUsedCount: number } | null {
  const arch = header.kv["general.architecture"];
  if (typeof arch !== "string") return null;
  const k = KEYS_FOR(arch);
  const total = asInt(header.kv[k.expertCount]);
  const used = asInt(header.kv[k.expertUsedCount]);
  if (total === null || used === null || total <= 1) return null;
  return { expertCount: total, expertUsedCount: used };
}

// ─── the ranged fetch ───────────────────────────────────────────────────────

export interface GgufReadOptions {
  fetchImpl?: typeof fetch;
  /** HF token; sent only as a Bearer header on the first request. */
  hfToken?: string;
  /** First range size. ~2 MB covers every llama.cpp-written header we've seen. */
  initialBytes?: number;
  /** Hard ceiling on bytes fetched. A full weights download must never happen. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export const DEFAULT_INITIAL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read `{arch}.block_count`, `.attention.head_count[_kv]`, `.embedding_length`
 * and `.context_length` from a remote GGUF file, via HTTP Range.
 *
 * Returns `{ok:false, error}` on any failure — never a guessed profile.
 */
export async function readGgufArchitecture(
  url: string,
  opts: GgufReadOptions = {},
): Promise<GgufArchitectureResult> {
  const read = await readHeaderUntil(
    url,
    opts,
    { initialBytes: DEFAULT_INITIAL_BYTES, maxBytes: DEFAULT_MAX_BYTES, growth: 4 },
    (header) => {
      const result = architectureFromHeader(header);
      // The header rides along on success: callers read other keys off it.
      return result.ok
        ? { ok: true, value: { architecture: result.architecture, header } }
        : { ok: false, error: result.error };
    },
  );
  return read.ok
    ? {
      ok: true,
      architecture: read.value.architecture,
      header: read.value.header,
      bytesRead: read.bytesRead,
    }
    : { ok: false, bytesRead: read.bytesRead, error: read.error };
}

// ─── the shared ranged read ─────────────────────────────────────────────────

/** What one window of the header yielded, or why it did not. */
type HeaderExtract<T> = { ok: true; value: T } | { ok: false; error: string };

interface EscalationPlan {
  initialBytes: number;
  maxBytes: number;
  /** Window multiplier per retry. */
  growth: number;
}

/**
 * One ranged GET of the first `want` bytes.
 *
 * A 200 instead of a 206 means the server ignored Range, which is only
 * survivable if the whole object happens to be inside the budget. Anything
 * else is reported rather than retried: silently downloading multi-gigabyte
 * weights to read a header is the one outcome this module exists to prevent.
 */
async function fetchHeaderPrefix(
  url: string,
  opts: GgufReadOptions,
  want: number,
  maxBytes: number,
): Promise<{ ok: true; buf: Uint8Array } | { ok: false; error: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Range: `bytes=0-${want - 1}` };
  if (opts.hfToken) headers.Authorization = `Bearer ${opts.hfToken}`;

  let res: Response;
  try {
    res = await doFetch(url, { headers, signal: opts.signal, redirect: "follow" });
  } catch (err) {
    return { ok: false, error: `GGUF range request failed: ${errText(err)}` };
  }

  if (res.status === 200) {
    const len = Number(res.headers.get("content-length") ?? "NaN");
    if (!Number.isFinite(len) || len > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: "server ignored the Range request and the object is larger than the " +
          `${maxBytes}-byte read budget; refusing to download the full weights`,
      };
    }
  } else if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      error: `GGUF range request returned HTTP ${res.status} ${res.statusText}`.trim(),
    };
  }
  return { ok: true, buf: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Read a growing prefix of the header until `extract` is satisfied.
 *
 * The escalation is what makes this shared rather than duplicated: the
 * architecture keys sit in the first 2 MB and the chat template sits behind the
 * tokenizer arrays, so the two callers differ only in where they start, how fast
 * they widen, and what they are looking for. Widening stops the moment the
 * header is NOT truncated — at that point the whole KV block was read and the
 * key is genuinely absent, so a bigger window cannot change the answer.
 */
async function readHeaderUntil<T>(
  url: string,
  opts: GgufReadOptions,
  plan: EscalationPlan,
  extract: (header: GgufHeader, bytesRead: number) => HeaderExtract<T>,
): Promise<
  { ok: true; value: T; bytesRead: number } | { ok: false; bytesRead: number; error: string }
> {
  const maxBytes = opts.maxBytes ?? plan.maxBytes;
  let want = Math.min(opts.initialBytes ?? plan.initialBytes, maxBytes);
  let bytesRead = 0;

  for (;;) {
    const prefix = await fetchHeaderPrefix(url, opts, want, maxBytes);
    if (!prefix.ok) return { ok: false, bytesRead, error: prefix.error };
    bytesRead = prefix.buf.byteLength;

    let header: GgufHeader;
    try {
      header = parseGgufHeader(prefix.buf);
    } catch (err) {
      return { ok: false, bytesRead, error: `GGUF header parse failed: ${errText(err)}` };
    }

    const found = extract(header, bytesRead);
    if (found.ok) return { ok: true, value: found.value, bytesRead };

    // `grew` guards against a server that returns less than asked: without it a
    // short response would loop forever asking for a window it never gets.
    const grew = prefix.buf.byteLength >= want;
    if (!header.truncated || !grew || want >= maxBytes) {
      return { ok: false, bytesRead, error: found.error };
    }
    want = Math.min(want * plan.growth, maxBytes);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── the chat template (FR-TOOL-003) ────────────────────────────────────────

export const CHAT_TEMPLATE_KEY = "tokenizer.chat_template";

/**
 * A GGUF-native repo ships no tokenizer_config.json, so the Jinja chat template
 * inside the file is the only place its tool support is written down.
 *
 * It sits MUCH deeper than the architecture keys. llama.cpp writes the tokenizer
 * block first — `tokenizer.ggml.tokens`, `.token_type`, `.merges` — which is
 * 4-6 MB for a 150k-token vocabulary and ~10 MB for a 250k one, and only then
 * the template. So this starts at 8 MB where readGgufArchitecture starts at 2,
 * and escalates once to 16 MB rather than giving up.
 */
export const DEFAULT_TEMPLATE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TEMPLATE_MAX_BYTES = 16 * 1024 * 1024;

export type GgufChatTemplateResult =
  | { ok: true; template: string; bytesRead: number }
  | { ok: false; bytesRead: number; error: string };

/**
 * Read `tokenizer.chat_template` from a remote GGUF file over HTTP Range.
 *
 * Returns `{ok:false}` when the key is past the read ceiling — deliberately, and
 * distinctly from "the template says no tools". The caller must keep those two
 * apart: one is unknown, the other is a measurement.
 */
export async function readGgufChatTemplate(
  url: string,
  opts: GgufReadOptions = {},
): Promise<GgufChatTemplateResult> {
  const read = await readHeaderUntil(
    url,
    opts,
    {
      initialBytes: DEFAULT_TEMPLATE_BYTES,
      maxBytes: DEFAULT_TEMPLATE_MAX_BYTES,
      // Doubling, not quadrupling: the first window is already 8 MB, and the
      // ceiling is 16, so one step is all there is room for.
      growth: 2,
    },
    (header, bytesRead) => {
      const template = header.kv[CHAT_TEMPLATE_KEY];
      if (typeof template === "string") return { ok: true, value: template };
      // "did not fit" and "is not there" are different answers and the caller
      // treats them differently — one is unknown, the other is a measurement.
      return {
        ok: false,
        error: header.truncated
          ? `${CHAT_TEMPLATE_KEY} was not within the ${bytesRead}-byte header read`
          : `${CHAT_TEMPLATE_KEY} is not present in this file`,
      };
    },
  );
  return read.ok
    ? { ok: true, template: read.value, bytesRead: read.bytesRead }
    : { ok: false, bytesRead: read.bytesRead, error: read.error };
}
