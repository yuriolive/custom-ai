/**
 * The copy-paste snippets (FR-MKT-008).
 *
 * These are the most load-bearing strings in the product: a developer's first
 * impression is whether the thing they copied off the model card runs. Three
 * details decide that, and all three have burned this project before.
 *
 *  1. **The model id.** `creator-handle/model-slug`, taken from the PLATFORM
 *     identity — NOT `hf_repo_slug`. The live example is
 *     `jonathancoletti/qwen3.8-27b-uncensored-gguf`.
 *     CASE does not matter: `resolve.ts` lowercases both halves, so
 *     `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` also resolves today —
 *     but ONLY because this seed's handle and slug happen to equal that path
 *     lowercased. It breaks as soon as they diverge, which is the normal case,
 *     since the handle is a platform identity unrelated to the HF account and
 *     the slug is chosen at registration.
 *     Case is forgiving; the names are not. `CatalogModel.modelId` is built
 *     from `creatorHandle`/`slug` for exactly this reason — never substitute
 *     the repo path here.
 *
 *  2. **The base URL.** The gateway is a Supabase Edge Function; its
 *     OpenAI-compatible root is `{supabase-url}/functions/v1/gateway/v1`. The
 *     trailing `/v1` is part of the base URL, and every SDK appends
 *     `/chat/completions` to it.
 *
 *  3. **The timeout.** Workers scale to zero (FR-DEP-031), so the first request
 *     to an idle model pays a cold start of up to two minutes. Every SDK ships a
 *     default timeout well under that — the OpenAI Python client defaults to
 *     600 s but `httpx` connect budgets and most proxies do not, and the
 *     TypeScript client defaults to 600 s only since v4. Setting it explicitly,
 *     with a comment saying why, is the difference between "slow first call"
 *     and "this product is broken".
 */

/** Timeout, in seconds, written into every generated snippet. */
export const SNIPPET_TIMEOUT_SECONDS = 180;

export type SnippetLanguage = "python" | "typescript" | "curl";

export const SNIPPET_LANGUAGES: readonly {
  id: SnippetLanguage;
  label: string;
  /** Syntax-highlighter dialect. */
  grammar: "python" | "typescript" | "bash";
}[] = [
  { id: "python", label: "Python", grammar: "python" },
  { id: "typescript", label: "TypeScript", grammar: "typescript" },
  { id: "curl", label: "cURL", grammar: "bash" },
];

export type SnippetInput = {
  /** `creator-handle/model-slug`, lowercase. */
  modelId: string;
  /** Gateway root INCLUDING the trailing `/v1`. */
  baseUrl: string;
};

const COLD_START_COMMENT =
  "the model scales to zero, so the first call may cold-start a GPU (up to ~2 min)";

const PROMPT = "Explain scale-to-zero GPU inference in two sentences.";

export function pythonSnippet({ modelId, baseUrl }: SnippetInput): string {
  return `# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="sk-plat-...",  # create one in the Console
)

stream = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "${PROMPT}"}],
    stream=True,
    # ${COLD_START_COMMENT}.
    # Subsequent calls to a warm worker return their first token in well under a second.
    timeout=${SNIPPET_TIMEOUT_SECONDS},
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
`;
}

export function typescriptSnippet({ modelId, baseUrl }: SnippetInput): string {
  return `// npm install openai
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: process.env.NEXUS_API_KEY, // sk-plat-... — create one in the Console
  // ${COLD_START_COMMENT}.
  // Subsequent calls to a warm worker return their first token in well under a second.
  timeout: ${SNIPPET_TIMEOUT_SECONDS}_000,
});

const stream = await client.chat.completions.create({
  model: "${modelId}",
  messages: [{ role: "user", content: "${PROMPT}" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
`;
}

export function curlSnippet({ modelId, baseUrl }: SnippetInput): string {
  return `# ${COLD_START_COMMENT}, hence --max-time.
# -N disables curl's output buffering so tokens appear as they stream.
curl -N ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer $NEXUS_API_KEY" \\
  -H "Content-Type: application/json" \\
  --max-time ${SNIPPET_TIMEOUT_SECONDS} \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "${PROMPT}"}],
    "stream": true
  }'
`;
}

export function snippetFor(
  language: SnippetLanguage,
  input: SnippetInput,
): string {
  switch (language) {
    case "python":
      return pythonSnippet(input);
    case "typescript":
      return typescriptSnippet(input);
    case "curl":
      return curlSnippet(input);
  }
}

/**
 * The gateway's OpenAI-compatible root, derived from the public Supabase URL.
 *
 * Derived rather than configured so it cannot drift from the deployment the
 * page is actually served by: a hard-coded production URL rendered on a local
 * build hands the developer a snippet that talks to the wrong environment.
 */
export function gatewayBaseUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/gateway/v1`;
}
