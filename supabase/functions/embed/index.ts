/**
 * The embedder — Supabase Edge Function (Deno).
 *
 *   POST /functions/v1/embed  {"query": "..."}            → {"embedding": [384 floats]}
 *   POST /functions/v1/embed  {"base_model_ids": [uuid]}  → {"embedded": n}  (service_role)
 *   OPTIONS *                                             → CORS preflight
 *
 * ONE function, two directions, on purpose: the query and the document must be
 * embedded BY THE SAME MODEL or the cosine distance between them is a number
 * about nothing. Two functions is two places for the model name to drift, and
 * the drift produces no error anywhere — just a semantic arm that quietly
 * retrieves the wrong models.
 *
 * ── Why this runs here and not in the Next.js server ────────────────────────
 * `Supabase.ai.Session` is a runtime global of the Edge Function sandbox: the
 * model is served by the platform, in-process, with no network call and NO API
 * KEY. That is the whole reason #28 adds no secret to CONTRACTS.md §Environment.
 * The alternative — OpenAI's or Cohere's embedding endpoint — is one more
 * credential to hold, rotate, and keep out of a NEXT_PUBLIC_ variable, in
 * exchange for a better model this catalog cannot yet tell apart.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * `verify_jwt = false` in config.toml, and the two paths are gated differently:
 *
 *   * the QUERY path is open, exactly as the catalog it serves is. It reads
 *     nothing, writes nothing, and returns 384 floats about the caller's own
 *     text. Gating it behind the anon key would gate it behind a value that is
 *     published in the browser bundle, which is not a gate.
 *   * the WRITE path requires the service-role key, compared in constant time.
 *     It is the only way `base_models.embedding` is written, and a creator who
 *     could write it could place their listing next to any query in the arm.
 *
 * OWNERSHIP: supabase/functions/embed/ — see docs/CONTRACTS.md.
 */

import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, MAX_QUERY_CHARS } from "./dimension.ts";
import { baseModelDocument, normalizeQuery } from "./document.ts";

// ─── Runtime globals ─────────────────────────────────────────────────────────

/**
 * `Supabase.ai.Session`, declared rather than imported: it is injected by the
 * edge runtime and has no module to import from. Narrow on purpose — this is the
 * whole surface this function uses, so a change in the platform's shape is a
 * type error here rather than a runtime one in production.
 */
declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(
        input: string,
        opts: { mean_pool: boolean; normalize: boolean },
      ): Promise<number[]>;
    };
  };
};

/** Reads Deno env when present, process.env otherwise (keeps the module testable). */
export function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) return g.Deno.env.get(name) ?? undefined;
  return g.process?.env?.[name] ?? undefined;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS_HEADERS };

/** How many base models one write call will embed. */
export const MAX_BATCH = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(message: string, status: number): Response {
  return json({ error: { message } }, status);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Length-safe constant-time comparison.
 *
 * `a === b` on a secret leaks its prefix through timing. That is a thin channel
 * over the public internet, and it is also two lines to close.
 */
export function secretEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  // Compare against a fixed-length buffer so the loop count does not depend on
  // the candidate's length either.
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * The bearer token on the request, if any.
 *
 * Split rather than matched. `/^Bearer\s+(.+)$/` reads better and backtracks
 * super-linearly on a long header, because `\s` and `.` overlap — and this runs
 * on an unauthenticated request, which is the one place a quadratic parse is
 * somebody else's lever.
 */
export function bearerToken(req: Request): string | undefined {
  const parts = (req.headers.get("authorization") ?? "").trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  if (parts[0]?.toLowerCase() !== "bearer") return undefined;
  return parts[1] || undefined;
}

// ─── Embedding ───────────────────────────────────────────────────────────────

let session: InstanceType<typeof Supabase.ai.Session> | null = null;

/**
 * One session per isolate, created on first use.
 *
 * Constructing it at module scope would pay the model load on every cold start
 * including the ones that never embed anything (a CORS preflight, a malformed
 * body), and the write path's cold start is already the slowest thing here.
 */
function getSession() {
  session ??= new Supabase.ai.Session(EMBEDDING_MODEL);
  return session;
}

/**
 * Text → a unit-length embedding.
 *
 * `mean_pool` and `normalize` are BOTH required and neither is a default worth
 * relying on. Mean pooling is how gte-small produces one vector for a sequence;
 * without normalization the vectors are not unit length, and cosine distance
 * against a non-normalized corpus is not the metric
 * `base_models_embedding_idx` was built for — the HNSW index would still answer,
 * with the wrong neighbours.
 */
export async function embed(text: string): Promise<number[]> {
  const output = await getSession().run(text, { mean_pool: true, normalize: true });
  if (!Array.isArray(output) || output.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `${EMBEDDING_MODEL} returned ${
        Array.isArray(output) ? output.length : typeof output
      } dimensions, expected ${EMBEDDING_DIMENSION}`,
    );
  }
  return output;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

type QueryBody = { query?: unknown };
type WriteBody = { base_model_ids?: unknown };

/** `{"query": "..."}` → `{"embedding": [...]}`. */
async function handleQuery(raw: unknown): Promise<Response> {
  if (typeof raw !== "string") return fail("`query` must be a string", 400);

  const query = normalizeQuery(raw);
  if (query.length === 0) return fail("`query` is empty", 400);
  if (raw.length > MAX_QUERY_CHARS * 4) {
    // Refused rather than silently truncated: a caller sending 8 KB of text is
    // not asking the question the truncation would answer.
    return fail(`\`query\` exceeds ${MAX_QUERY_CHARS * 4} characters`, 413);
  }

  return json({
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIMENSION,
    embedding: await embed(query),
  });
}

/**
 * `{"base_model_ids": [...]}` → embed each and write it back.
 *
 * Called at DEPLOY time, once per base model, by the resolution cascade. Reads
 * and writes with the service-role key: `base_models` has no client write policy
 * at all, deliberately (20260820000100).
 */
async function handleWrite(rawIds: unknown, req: Request): Promise<Response> {
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!secretEquals(bearerToken(req), serviceRoleKey)) {
    // 404, not 403: the write path does not confirm its own existence to a
    // caller who cannot use it.
    return fail("not found", 404);
  }

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return fail("`base_model_ids` must be a non-empty array", 400);
  }
  if (rawIds.length > MAX_BATCH) {
    return fail(`at most ${MAX_BATCH} base models per call`, 400);
  }
  const ids = rawIds.filter((id): id is string => typeof id === "string");
  if (ids.length !== rawIds.length) return fail("`base_model_ids` must be uuids", 400);

  const supabaseUrl = getEnv("SUPABASE_URL");
  if (!supabaseUrl || !serviceRoleKey) return fail("embedder is not configured", 500);

  const restHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };

  // PostgREST directly rather than @supabase/supabase-js: two HTTP calls against
  // a stable REST contract, versus a dependency the gateway also does without.
  const selected = await fetch(
    `${supabaseUrl}/rest/v1/base_models` +
      `?select=id,display_name,slug,family,summary,use_cases,parameter_count` +
      `&id=in.(${ids.join(",")})`,
    { headers: restHeaders },
  );
  if (!selected.ok) return fail(`base_models read failed: ${selected.status}`, 502);

  const rows = (await selected.json()) as (
    & { id: string }
    & Parameters<
      typeof baseModelDocument
    >[0]
  )[];

  let embedded = 0;
  for (const row of rows) {
    const document = baseModelDocument(row);
    // A row with nothing to say is left NULL rather than embedded as the empty
    // string: the embedding of "" is a fixed point of the space that would be
    // the same distance from every query, i.e. a model that ranks in the arm for
    // everything.
    if (document.length === 0) continue;

    const vector = await embed(document);
    const written = await fetch(`${supabaseUrl}/rest/v1/rpc/set_base_model_embedding`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({
        p_base_model_id: row.id,
        // pgvector's input syntax, which is also JSON array syntax. The RPC
        // re-checks the width against `embedding_dimension()`.
        p_embedding: JSON.stringify(vector),
      }),
    });
    if (!written.ok) {
      return fail(`embedding write failed for ${row.id}: ${written.status}`, 502);
    }
    embedded++;
  }

  return json({ model: EMBEDDING_MODEL, dimension: EMBEDDING_DIMENSION, embedded });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return fail("method not allowed", 405);

  let body: QueryBody & WriteBody;
  try {
    body = (await req.json()) as QueryBody & WriteBody;
  } catch {
    return fail("body must be JSON", 400);
  }

  if (body && "base_model_ids" in body) return await handleWrite(body.base_model_ids, req);
  if (body && "query" in body) return await handleQuery(body.query);
  return fail("expected `query` or `base_model_ids`", 400);
}

// Only serve when executed as the Edge Function entrypoint; importing this
// module (tests, tooling) must not open a listener.
// deno-lint-ignore no-explicit-any
const _g = globalThis as any;
if (_g.Deno?.serve && import.meta.main) {
  _g.Deno.serve((req: Request) => handleRequest(req));
}
