/**
 * Chat-template tool-support detection — FR-TOOL-003.
 *
 * The three sources are exercised in the order resolveToolSupport tries them,
 * and the distinction that matters most is asserted throughout: `false` is a
 * measurement and `null` is "could not read", and the gateway treats them
 * differently (400 vs forward).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_TEMPLATE_FILE,
  detectToolSupport,
  resolveToolSupport,
  TOKENIZER_CONFIG_FILE,
} from "../src/chat-template.ts";
import { CHAT_TEMPLATE_KEY, readGgufChatTemplate } from "../src/gguf.ts";

// ─── the pure decision ──────────────────────────────────────────────────────

/** Qwen3-shaped: the `tools` branch plus the assistant-side replay. */
const QWEN_TEMPLATE = `{%- if tools %}
  <tools>{% for tool in tools %}{{ tool | tojson }}{% endfor %}</tools>
{%- endif %}
{%- for message in messages %}
  {%- if message.tool_calls %}<tool_call>{{ message.tool_calls[0] }}</tool_call>{%- endif %}
{%- endfor %}`;

/** Mistral-shaped: a different spelling of the same capability. */
const MISTRAL_TEMPLATE = `{%- if tools is defined %}[AVAILABLE_TOOLS]{{ tools }}[/AVAILABLE_TOOLS]{%- endif %}`;

/** A plain chat template: roles, BOS/EOS, and nothing else. */
const PLAIN_TEMPLATE = `{% for message in messages %}<|im_start|>{{ message.role }}
{{ message.content }}<|im_end|>
{% endfor %}<|im_start|>assistant
`;

test("a template that references tools is tool-capable", () => {
  assert.equal(detectToolSupport(QWEN_TEMPLATE), true);
  assert.equal(detectToolSupport(MISTRAL_TEMPLATE), true);
  assert.equal(detectToolSupport("{{ tool_calls }}"), true);
});

test("a plain chat template is measured as false, not unknown", () => {
  assert.equal(detectToolSupport(PLAIN_TEMPLATE), false);
});

test("a template that only CONSUMES tool results does not count as declaring tools", () => {
  // `role == "tool"` renders a tool RESULT. A template that can do that but
  // cannot render a tool DEFINITION would answer in prose — the failure this
  // flag exists to catch, so the loose `tools` match must not fire on it.
  const resultsOnly = `{% for m in messages %}{% if m.role == 'tool' %}{{ m.content }}{% endif %}{% endfor %}`;
  assert.equal(detectToolSupport(resultsOnly), false);
});

test("absent or blank is null — unknown, which is not the same as false", () => {
  assert.equal(detectToolSupport(null), null);
  assert.equal(detectToolSupport(undefined), null);
  assert.equal(detectToolSupport(""), null);
  assert.equal(detectToolSupport("   \n\t "), null);
  assert.equal(detectToolSupport(42 as unknown as string), null);
});

// ─── source resolution ──────────────────────────────────────────────────────

/** Serves a fixed body per URL suffix; anything else 404s, like the Hub. */
function hubServer(routes: Record<string, string>, seen: string[] = []) {
  return async (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    seen.push(href);
    for (const [suffix, body] of Object.entries(routes)) {
      if (href.endsWith(suffix)) return new Response(body, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

test("chat_template.jinja is preferred and stops the search", async () => {
  const seen: string[] = [];
  const res = await resolveToolSupport("owner/repo", {
    files: [CHAT_TEMPLATE_FILE, TOKENIZER_CONFIG_FILE],
    fetchImpl: hubServer({ [CHAT_TEMPLATE_FILE]: QWEN_TEMPLATE }, seen) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { supported: true, source: "chat_template_file" });
  assert.equal(seen.length, 1, "a decided answer must not keep fetching");
});

test("tokenizer_config.json is read when there is no template file", async () => {
  const res = await resolveToolSupport("owner/repo", {
    files: [TOKENIZER_CONFIG_FILE],
    fetchImpl: hubServer({
      [TOKENIZER_CONFIG_FILE]: JSON.stringify({ chat_template: PLAIN_TEMPLATE }),
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { supported: false, source: "tokenizer_config" });
});

test("the legacy list-of-named-templates form is folded, tool variant included", async () => {
  // Pre-split repos kept the tool-calling variant as a SEPARATE entry, so
  // reading only the first template reports a tool-capable model as incapable.
  const res = await resolveToolSupport("owner/repo", {
    files: [TOKENIZER_CONFIG_FILE],
    fetchImpl: hubServer({
      [TOKENIZER_CONFIG_FILE]: JSON.stringify({
        chat_template: [
          { name: "default", template: PLAIN_TEMPLATE },
          { name: "tool_use", template: MISTRAL_TEMPLATE },
        ],
      }),
    }) as unknown as typeof fetch,
  });
  assert.equal(res.supported, true);
  assert.equal(res.source, "tokenizer_config");
});

test("a repo with no template at all is unknown, never false", async () => {
  const res = await resolveToolSupport("owner/repo", {
    files: ["README.md", "model-Q4_K_M.gguf"],
    fetchImpl: hubServer({}) as unknown as typeof fetch,
  });
  assert.equal(res.supported, null);
  assert.equal(res.source, null);
  assert.ok(res.error);
});

test("a transport failure is unknown, and never throws into a deployment", async () => {
  const res = await resolveToolSupport("owner/repo", {
    files: [CHAT_TEMPLATE_FILE],
    fetchImpl: (() => Promise.reject(new Error("DNS exploded"))) as unknown as typeof fetch,
  });
  assert.equal(res.supported, null);
  assert.match(res.error ?? "", /DNS exploded/);
});

// ─── the GGUF fallback, which is the ONLY path for a llama.cpp-native repo ───

const T_STRING = 8;
const T_ARRAY = 9;

class Writer {
  parts: Uint8Array[] = [];
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
  u64(n: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return this.raw(b);
  }
  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    return this.u64(bytes.length).raw(bytes);
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

/**
 * A v3 GGUF whose chat template sits AFTER a large token array — the real
 * layout, and the reason this read starts at 8 MB rather than 2.
 */
function ggufWithTemplate(template: string | null, vocab: number): Uint8Array {
  const w = new Writer();
  const kvCount = template === null ? 2 : 3;
  w.ascii("GGUF").u32(3).u64(0).u64(kvCount);
  w.str("general.architecture").u32(T_STRING).str("qwen3");
  w.str("tokenizer.ggml.tokens").u32(T_ARRAY).u32(T_STRING).u64(vocab);
  for (let i = 0; i < vocab; i++) w.str(`token-${i}`);
  if (template !== null) w.str(CHAT_TEMPLATE_KEY).u32(T_STRING).str(template);
  return w.bytes();
}

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

test("readGgufChatTemplate reads tokenizer.chat_template from behind the vocabulary", async () => {
  const body = ggufWithTemplate(QWEN_TEMPLATE, 500);
  const calls: string[] = [];
  const r = await readGgufChatTemplate("https://example.test/model.gguf", {
    fetchImpl: rangeServer(body, calls) as unknown as typeof fetch,
    initialBytes: body.byteLength,
    maxBytes: body.byteLength,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(detectToolSupport(r.template), true);
  assert.equal(calls.length, 1);
});

test("readGgufChatTemplate widens the window rather than reporting absent", async () => {
  const body = ggufWithTemplate(QWEN_TEMPLATE, 2000);
  const calls: string[] = [];
  const r = await readGgufChatTemplate("https://example.test/model.gguf", {
    fetchImpl: rangeServer(body, calls) as unknown as typeof fetch,
    initialBytes: 512,
    maxBytes: body.byteLength,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.ok(calls.length > 1, `expected escalation, got ${calls.join(" ")}`);
});

test("a truncated read is an error, distinct from the key being absent", async () => {
  const body = ggufWithTemplate(QWEN_TEMPLATE, 2000);
  const truncated = await readGgufChatTemplate("https://example.test/model.gguf", {
    fetchImpl: rangeServer(body) as unknown as typeof fetch,
    initialBytes: 256,
    maxBytes: 256,
  });
  assert.equal(truncated.ok, false);
  assert.match(truncated.ok ? "" : truncated.error, /not within/);

  const absent = await readGgufChatTemplate("https://example.test/model.gguf", {
    fetchImpl: rangeServer(ggufWithTemplate(null, 20)) as unknown as typeof fetch,
    initialBytes: 1 << 20,
    maxBytes: 1 << 20,
  });
  assert.equal(absent.ok, false);
  assert.match(absent.ok ? "" : absent.error, /not present/);
});

test("a GGUF-only repo resolves through the header, and reports the source", async () => {
  const body = ggufWithTemplate(QWEN_TEMPLATE, 200);
  const gguf = rangeServer(body);
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    // The Hub 404s the two template files; only the .gguf serves.
    if (String(url).endsWith(".gguf")) return gguf(url, init);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const res = await resolveToolSupport("owner/repo", {
    files: ["README.md", "model-Q4_K_M.gguf"],
    ggufFile: "model-Q4_K_M.gguf",
    fetchImpl,
    maxBytes: body.byteLength,
  });
  assert.deepEqual(res, { supported: true, source: "gguf_header" });
});
