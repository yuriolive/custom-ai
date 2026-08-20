/**
 * The query half of hybrid retrieval (#28): free text → a gte-small embedding.
 *
 * ── Why this is a network call and not a library ────────────────────────────
 * The model runs inside the Edge Function, as `Supabase.ai.Session('gte-small')`.
 * That is what keeps CONTRACTS.md §Environment unchanged — there is no external
 * embedding API, therefore no key to hold — and it is also what makes the query
 * and the document provably comparable: both vectors come out of the same
 * process running the same weights. A second embedder here, however convenient,
 * would be a second model, and cosine distance between two different models'
 * output is a number about nothing.
 *
 * ── Why every failure returns null ──────────────────────────────────────────
 * A null embedding costs the visitor the semantic arm and nothing else: the
 * caller falls back to the lexical catalog query, which is what the catalog did
 * before this existed. An exception, by contrast, would take down the front door
 * of the marketplace because a model server was slow. The semantic arm is an
 * IMPROVEMENT to search, and an improvement that can 500 the page is a
 * regression.
 *
 * ── Debouncing ──────────────────────────────────────────────────────────────
 * The debounce the issue asks for is already on the client, in
 * `catalog-controls.tsx` (`SEARCH_DEBOUNCE_MS`): the search box only writes `?q=`
 * 300 ms after the last keystroke, and this function runs once per navigation.
 * Adding a second debounce here would be debouncing a value that is already
 * settled.
 */

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/public-config";

import { shouldEmbedQuery } from "./search-query.ts";

/**
 * How long the catalog will wait for an embedding.
 *
 * The budget is the visitor's patience, not the model's comfort: past this the
 * page renders the lexical result, which is a complete answer. gte-small on a
 * warm isolate answers in tens of milliseconds; this bound is for the cold one.
 */
export const EMBED_TIMEOUT_MS = 1_500;

/**
 * Free text → a 384-float embedding, or `null`.
 *
 * `null` means "search lexically", and it covers every reason at once: too short
 * to be worth embedding, the embedder is down, the embedder was slow, the
 * embedder answered with something that is not an embedding. The caller does not
 * need to tell them apart — the fallback is identical, and a query string is not
 * a thing worth logging a distinction about.
 */
export async function embedSearchQuery(
  text: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<number[] | null> {
  if (!shouldEmbedQuery(text)) return null;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The function itself runs with `verify_jwt = false`, but the platform's
        // edge gateway still expects a project key on the request. The anon key
        // is publishable by design (CONTRACTS.md §Environment) and grants nothing
        // here: the write path compares the SERVICE-ROLE key, and this is not it.
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ query: text }),
      signal: signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const payload: unknown = await response.json();
    const embedding = (payload as { embedding?: unknown } | null)?.embedding;

    // Shape-checked rather than trusted. The RPC drops a wrong-width vector too,
    // but it drops it AFTER a round trip carrying 384 floats; failing here keeps
    // a broken embedder from costing the catalog its latency as well as its
    // semantic arm.
    if (!Array.isArray(embedding)) return null;
    if (!embedding.every((n) => typeof n === "number" && Number.isFinite(n))) return null;

    return embedding as number[];
  } catch {
    // Timeout, abort, DNS, malformed JSON — all of them mean the same thing to
    // the caller.
    return null;
  }
}
