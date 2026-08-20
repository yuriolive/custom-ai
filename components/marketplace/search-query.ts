/**
 * Free text → the two server-side search predicates the catalog runs.
 *
 * Its own module, and pure, for one reason: `queries.ts` imports
 * `@supabase/supabase-js`, which `node --test` cannot resolve, and the tokenizer
 * below is the half of the search path that MUST STAY IN STEP WITH SQL. The RPC
 * re-validates `p_ts_query` against a pattern describing exactly this function's
 * output (20260820001000), and if the two drift the failure is silent in the
 * worst direction: the RPC discards the query as malformed and returns the whole
 * catalog, which reads as "search found a lot" rather than as an error.
 * `grouped-catalog.test.ts` asserts that agreement by lifting the pattern out of
 * the migration, and it can only do that if this module loads on its own.
 *
 * `.ts` extensions on the relative imports for the same reason — see the header
 * of `format.ts`.
 */

/**
 * Free text → a prefix `tsquery`, safe to interpolate into a PostgREST filter.
 *
 * Prefix matching (`token:*`) rather than plain `to_tsquery`, because this is a
 * search-as-you-type box: "qwen" must match `qwen3.8` on the fourth keystroke,
 * not only once the whole lexeme is typed.
 *
 * The character class is the load-bearing part. Dots and hyphens are KEPT,
 * because `to_tsvector` emits `qwen3.8` and `qwen3.8-27b-uncensored-gguf` as
 * single lexemes — splitting the user's `qwen3.8` into `qwen3` and `8` turns a
 * hit into a miss, since `8:*` prefixes nothing in that vector. Everything else
 * is dropped, which keeps the value legal inside a PostgREST `or=(…)` tree and
 * makes a malformed `to_tsquery` — a 500 on the front page — unreachable.
 */
export function toPrefixTsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, " ")
    .split(" ")
    .map((token) => token.replace(/^[._/-]+/, "").replace(/[._/-]+$/, ""))
    // At least one alphanumeric: `to_tsquery('english', '-:*')` is a syntax error.
    .filter((token) => /[a-z0-9]/.test(token))
    .slice(0, 8);

  return tokens.length > 0 ? tokens.map((token) => `${token}:*`).join("&") : null;
}

/**
 * Handle-shaped fragment for an `ilike`. Strips `%`, `_`, `,` and `*`.
 *
 * Two characters minimum: a one-character fragment matches most of the platform's
 * handles, which is not a search result, it is the whole table.
 */
export function handleFragment(text: string): string | null {
  const fragment = text.toLowerCase().replace(/[^a-z0-9-]+/g, "");
  return fragment.length >= 2 ? fragment : null;
}

/**
 * Below this many characters the semantic arm is skipped and prefix FTS answers
 * alone (#28).
 *
 * Prefix FTS is STRICTLY BETTER here, not merely cheaper: `qw` is a legal prefix
 * of `qwen` and matches it exactly, while the embedding of `qw` is an embedding
 * of nothing — two characters carry no semantics, so the nearest neighbours of
 * that vector are an arbitrary corner of the space. Running the model on it costs
 * an inference and returns noise.
 *
 * Duplicated from `supabase/functions/embed/dimension.ts`, which is the
 * embedder's own copy, because the two live in different runtimes and neither
 * tree may import the other. `hybrid-search.test.ts` asserts the two agree, the
 * same way this module's tsquery output is asserted against the RPC's pattern.
 */
export const MIN_SEMANTIC_QUERY_LENGTH = 3;

/**
 * True when a query is worth embedding.
 *
 * Length is measured on the TRIMMED text: `  q ` is a one-character query with
 * padding, and paying for an inference on it would be paying for the padding.
 */
export function shouldEmbedQuery(text: string): boolean {
  return text.trim().length >= MIN_SEMANTIC_QUERY_LENGTH;
}
