/**
 * GGUF key-value header reader — FR-DEP-043 path 2.
 * Builds synthetic v2 and v3 headers so the parser is tested without network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  architectureFromHeader,
  deriveAttentionLayers,
  parseGgufHeader,
  readGgufArchitecture,
} from "../src/gguf.ts";

// ─── a tiny GGUF writer, for tests only ─────────────────────────────────────

const T = {
  UINT32: 4,
  FLOAT32: 6,
  STRING: 8,
  ARRAY: 9,
} as const;

class Writer {
  parts: Uint8Array[] = [];
  wide: boolean;
  constructor(wide: boolean) {
    this.wide = wide;
  }
  raw(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  ascii(s: string): this {
    return this.raw(new TextEncoder().encode(s));
  }
  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.raw(b);
  }
  f32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    return this.raw(b);
  }
  u64(n: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return this.raw(b);
  }
  len(n: number): this {
    return this.wide ? this.u64(n) : this.u32(n);
  }
  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    return this.len(bytes.length).raw(bytes);
  }
  bytes(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

type KvPair = [string, number, unknown];

function buildGguf(
  version: number,
  kv: KvPair[],
  opts: { trailingJunk?: number } = {},
): Uint8Array {
  const wide = version >= 2;
  const w = new Writer(wide);
  w.ascii("GGUF").u32(version);
  if (wide) w.u64(0).u64(kv.length);
  else w.u32(0).u32(kv.length);
  for (const [key, type, value] of kv) {
    w.str(key).u32(type);
    if (type === T.UINT32) w.u32(value as number);
    else if (type === T.FLOAT32) w.f32(value as number);
    else if (type === T.STRING) w.str(value as string);
    else if (type === T.ARRAY) {
      const arr = value as string[];
      w.u32(T.STRING).len(arr.length);
      for (const s of arr) w.str(s);
    } else throw new Error(`test writer cannot emit type ${type}`);
  }
  if (opts.trailingJunk) w.raw(new Uint8Array(opts.trailingJunk));
  return w.bytes();
}

/** The MVP target's shape: Qwen3-ish GQA geometry. */
const QWEN_KV: KvPair[] = [
  ["general.architecture", T.STRING, "qwen3"],
  ["general.name", T.STRING, "Qwen3.8-27B-Uncensored"],
  ["qwen3.block_count", T.UINT32, 64],
  ["qwen3.context_length", T.UINT32, 262144],
  ["qwen3.embedding_length", T.UINT32, 5120],
  ["qwen3.attention.head_count", T.UINT32, 40],
  ["qwen3.attention.head_count_kv", T.UINT32, 8],
  ["qwen3.attention.key_length", T.UINT32, 128],
  ["qwen3.rope.freq_base", T.FLOAT32, 1_000_000],
];

// ─── parser ─────────────────────────────────────────────────────────────────

for (const version of [2, 3]) {
  test(`GGUF v${version}: architecture is extracted from the KV header`, () => {
    const header = parseGgufHeader(buildGguf(version, QWEN_KV));
    assert.equal(header.version, version);
    const r = architectureFromHeader(header);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.architecture, {
      nLayers: 64,
      // Plain transformer: no interval key, so every block holds KV.
      nAttentionLayers: 64,
      fullAttentionInterval: null,
      nKvHeads: 8,
      nAttentionHeads: 40,
      hiddenSize: 5120,
      headDim: 128,
      maxPositionEmbeddings: 262144,
      ssm: null,
      architecture: "qwen3",
      source: "gguf-header",
    });
  });
}

test("headDim falls back to hidden_size / head_count when key_length is absent", () => {
  const kv = QWEN_KV.filter(([k]) => k !== "qwen3.attention.key_length");
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, kv)));
  assert.ok(r.ok);
  assert.equal(r.architecture.headDim, 128); // 5120 / 40
});

test("Qwen3 geometry: head_dim is decoupled from hidden_size / head_count", () => {
  // The REAL live values from the MVP target repo: 5120 / 24 = 213.33, but the
  // model's actual head_dim is 128. Trusting the division here would inflate
  // every KV-cache estimate by 1.66x.
  const kv: KvPair[] = [
    ["general.architecture", T.STRING, "qwen3"],
    ["qwen3.block_count", T.UINT32, 64],
    ["qwen3.context_length", T.UINT32, 262144],
    ["qwen3.embedding_length", T.UINT32, 5120],
    ["qwen3.attention.head_count", T.UINT32, 24],
    ["qwen3.attention.head_count_kv", T.UINT32, 4],
    ["qwen3.attention.key_length", T.UINT32, 128],
  ];
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, kv)));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.headDim, 128);
  assert.equal(r.architecture.nKvHeads, 4);

  // Same model without key_length: the fallback does not divide evenly, so we
  // reject rather than emit 213.
  const noKeyLen = architectureFromHeader(
    parseGgufHeader(
      buildGguf(
        3,
        kv.filter(([k]) => k !== "qwen3.attention.key_length"),
      ),
    ),
  );
  assert.equal(noKeyLen.ok, false);
  assert.match((noKeyLen as { error: string }).error, /cannot derive head_dim/);
});

// ─── hybrid attention/SSM geometry ──────────────────────────────────────────

/** The MVP target's REAL header, transcribed from the live 2 MB range read. */
const QWEN35_LIVE_KV: KvPair[] = [
  ["general.architecture", T.STRING, "qwen35"],
  ["qwen35.block_count", T.UINT32, 65],
  ["qwen35.context_length", T.UINT32, 262144],
  ["qwen35.embedding_length", T.UINT32, 5120],
  ["qwen35.feed_forward_length", T.UINT32, 17408],
  ["qwen35.attention.head_count", T.UINT32, 24],
  ["qwen35.attention.head_count_kv", T.UINT32, 4],
  ["qwen35.attention.key_length", T.UINT32, 256],
  ["qwen35.attention.value_length", T.UINT32, 256],
  ["qwen35.nextn_predict_layers", T.UINT32, 1],
  ["qwen35.ssm.conv_kernel", T.UINT32, 4],
  ["qwen35.ssm.state_size", T.UINT32, 128],
  ["qwen35.ssm.group_count", T.UINT32, 16],
  ["qwen35.ssm.inner_size", T.UINT32, 6144],
  ["qwen35.full_attention_interval", T.UINT32, 4],
];

test("hybrid: the live MVP target header yields 16 attention layers of 65 blocks", () => {
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, QWEN35_LIVE_KV)));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.architecture, {
    nLayers: 65,
    // 65 blocks - 1 MTP block = 64 transformer blocks; 1 in 4 is full attention.
    // Multiplying KV over all 65 would over-size the cache by ~4x.
    nAttentionLayers: 16,
    fullAttentionInterval: 4,
    nKvHeads: 4,
    nAttentionHeads: 24,
    hiddenSize: 5120,
    headDim: 256,
    maxPositionEmbeddings: 262144,
    ssm: { stateSize: 128, innerSize: 6144, groupCount: 16, convKernel: 4 },
    architecture: "qwen35",
    source: "gguf-header",
  });
});

test("hybrid: the noMTP family independently agrees on 16 attention layers", () => {
  // Same repo, other family: 64 blocks and no MTP block. If the MTP
  // subtraction were wrong the two families would disagree here.
  const kv = QWEN35_LIVE_KV.map(([k, t, v]): KvPair =>
    k === "qwen35.block_count"
      ? [k, t, 64]
      : k === "qwen35.nextn_predict_layers"
        ? [k, t, 0]
        : [k, t, v],
  );
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, kv)));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.nLayers, 64);
  assert.equal(r.architecture.nAttentionLayers, 16);
});

test("deriveAttentionLayers: the rule, stated as a table", () => {
  //          nLayers, interval, mtp -> attention layers
  const rows: [number, number | null, number, number][] = [
    [65, 4, 1, 16], // MVP target, base family
    [64, 4, 0, 16], // MVP target, noMTP family
    [64, null, 0, 64], // plain transformer: every block holds KV
    [64, 1, 0, 64], // interval 1 is a plain transformer spelled out
    [48, 4, 0, 12],
    [65, 4, 0, 16], // floor: the trailing partial group is not counted
    [3, 4, 0, 1], // never zero out a model that does have attention
    [64, null, 2, 62], // MTP heads hold no KV for the served sequence
  ];
  for (const [n, interval, mtp, want] of rows) {
    assert.equal(deriveAttentionLayers(n, interval, mtp), want, `${n}/${interval}/${mtp}`);
  }
});

test("hybrid: ssm is null on a plain transformer, and group_count defaults to 1", () => {
  const plain = architectureFromHeader(parseGgufHeader(buildGguf(3, QWEN_KV)));
  assert.ok(plain.ok);
  assert.equal(plain.architecture.ssm, null);
  assert.equal(plain.architecture.fullAttentionInterval, null);

  // Mamba-1 style: no ssm.group_count key at all.
  const mamba = QWEN35_LIVE_KV.filter(([k]) => k !== "qwen35.ssm.group_count");
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, mamba)));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.ssm!.groupCount, 1);
});

test("the raw architecture string is passed through, never validated", () => {
  const kv = QWEN35_LIVE_KV.map(([k, t, v]): KvPair =>
    k === "general.architecture"
      ? [k, t, "some-arch-invented-next-week"]
      : [k.replace(/^qwen35\./, "some-arch-invented-next-week."), t, v],
  );
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, kv)));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.architecture, "some-arch-invented-next-week");
  assert.equal(r.architecture.nAttentionLayers, 16);
});

test("head_count_kv absent means MHA, not unknown", () => {
  const kv = QWEN_KV.filter(([k]) => k !== "qwen3.attention.head_count_kv");
  const r = architectureFromHeader(parseGgufHeader(buildGguf(3, kv)));
  assert.ok(r.ok);
  assert.equal(r.architecture.nKvHeads, 40);
});

test("a huge tokenizer array after the required keys does not block the read", () => {
  const kv: KvPair[] = [
    ...QWEN_KV,
    ["tokenizer.ggml.tokens", T.ARRAY, Array.from({ length: 5000 }, (_, i) => `tok${i}`)],
  ];
  const full = buildGguf(3, kv);
  // Cut the buffer mid-tokenizer-array: the parser must still succeed.
  const truncated = full.subarray(0, Math.floor(full.byteLength * 0.6));
  const header = parseGgufHeader(truncated);
  assert.equal(header.truncated, true, "the prefix really does end inside the array");
  const r = architectureFromHeader(header);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.nLayers, 64);
  // key_length is written after the four mandatory keys — it must survive.
  assert.equal(r.architecture.headDim, 128);
});

test("a prefix that ends before the required keys is reported, never guessed", () => {
  const full = buildGguf(3, QWEN_KV);
  const header = parseGgufHeader(full.subarray(0, 60));
  assert.equal(header.truncated, true);
  const r = architectureFromHeader(header);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /missing required key|before general.architecture/i);
});

test("a non-GGUF payload is rejected, not interpreted", () => {
  assert.throws(
    () => parseGgufHeader(new TextEncoder().encode("<!doctype html>....")),
    /not a GGUF/,
  );
});

test("an unsupported GGUF version is rejected", () => {
  const b = buildGguf(3, QWEN_KV);
  new DataView(b.buffer, b.byteOffset).setUint32(4, 9, true);
  assert.throws(() => parseGgufHeader(b), /unsupported GGUF version/);
});

// ─── the ranged fetch ───────────────────────────────────────────────────────

function rangeServer(body: Uint8Array, calls: string[] = []) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const range = String((init?.headers as Record<string, string>)?.Range ?? "");
    calls.push(range);
    const m = /bytes=0-(\d+)/.exec(range);
    const end = m ? Math.min(Number(m[1]) + 1, body.byteLength) : body.byteLength;
    const slice = body.subarray(0, end);
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        "content-range": `bytes 0-${end - 1}/${body.byteLength}`,
        "content-length": String(slice.byteLength),
      },
    });
  };
}

test("readGgufArchitecture reads only a prefix via HTTP Range", async () => {
  const body = buildGguf(3, QWEN_KV, { trailingJunk: 5_000_000 });
  const calls: string[] = [];
  const r = await readGgufArchitecture("https://example.test/model.gguf", {
    fetchImpl: rangeServer(body, calls) as unknown as typeof fetch,
    initialBytes: 1024,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.nKvHeads, 8);
  assert.deepEqual(calls, ["bytes=0-1023"]);
  assert.ok(r.bytesRead <= 1024, `read ${r.bytesRead} bytes`);
});

test("readGgufArchitecture widens the window once, up to the ceiling", async () => {
  // Pad the header with junk keys so the first small window is not enough.
  const kv: KvPair[] = [
    ["general.architecture", T.STRING, "qwen3"],
    ["padding", T.ARRAY, Array.from({ length: 400 }, (_, i) => `pad-value-${i}`)],
    ...QWEN_KV.slice(1),
  ];
  const body = buildGguf(3, kv);
  const calls: string[] = [];
  const r = await readGgufArchitecture("https://example.test/model.gguf", {
    fetchImpl: rangeServer(body, calls) as unknown as typeof fetch,
    initialBytes: 256,
    maxBytes: 1 << 20,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.ok(calls.length > 1, `expected escalation, got ${calls.join(" ")}`);
});

test("readGgufArchitecture refuses when the server ignores Range on a big object", async () => {
  const fake = async () =>
    new Response(new Uint8Array(16), {
      status: 200,
      headers: { "content-length": String(30_000_000_000) },
    });
  const r = await readGgufArchitecture("https://example.test/model.gguf", {
    fetchImpl: fake as unknown as typeof fetch,
  });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /ignored the Range request/i);
});

test("readGgufArchitecture surfaces an HTTP error instead of guessing", async () => {
  const fake = async () => new Response("nope", { status: 403, statusText: "Forbidden" });
  const r = await readGgufArchitecture("https://example.test/model.gguf", {
    fetchImpl: fake as unknown as typeof fetch,
  });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /HTTP 403/);
});

test("readGgufArchitecture surfaces a network failure instead of guessing", async () => {
  const fake = async () => {
    throw new TypeError("fetch failed");
  };
  const r = await readGgufArchitecture("https://example.test/model.gguf", {
    fetchImpl: fake as unknown as typeof fetch,
  });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /range request failed/i);
});
