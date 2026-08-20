/**
 * The embedding model, and everything that is a property OF THE MODEL rather
 * than of this codebase.
 *
 * Its own module, and pure, because these constants have to be readable from
 * three places that do not share a runtime: the Edge Function handler (Deno),
 * the Next.js server that embeds a search query (Node), and `node --test`. A
 * literal `384` written in each of them is three things to change when the model
 * changes — and the failure mode of missing one is silent: a wrong-width vector
 * is dropped by `search_base_models`, so the semantic arm simply stops
 * contributing and search still "works".
 *
 * SQL holds its own copy in `public.embedding_dimension()`, because a column
 * typmod cannot be taken from a function; pgTAP pins the two to each other
 * (07_base_models_test.sql), and 09_search_rrf_test.sql builds its fixtures from
 * the function rather than from a literal for the same reason.
 */

/**
 * `gte-small`, run by `Supabase.ai.Session('gte-small')` INSIDE the Edge
 * Function runtime.
 *
 * That choice is the reason there is no new secret in CONTRACTS.md §Environment:
 * the model is served by the platform, in-process, so there is no external API
 * to hold a key for. It is also the reason the column is 384 wide and not 1536.
 *
 * gte-small is ENGLISH-ONLY. Model cards are overwhelmingly English so the
 * corpus is fine, but a Portuguese query will underperform — it will be embedded
 * into a space that never saw the language, and the lexical arm is what will
 * carry it. Swapping the model is one env var, a re-embed, and a dimension
 * change; that is what this module is for.
 */
export const EMBEDDING_MODEL = "gte-small";

/** gte-small's output width. Must equal `public.embedding_dimension()`. */
export const EMBEDDING_DIMENSION = 384;

/**
 * Below this many characters the vector arm is skipped entirely.
 *
 * Prefix FTS is STRICTLY BETTER on one and two characters: `qw` is a legal
 * prefix of `qwen` and matches it exactly, while an embedding of `qw` is an
 * embedding of nothing — two characters carry no semantics, so the nearest
 * neighbours of that vector are an arbitrary corner of the space. Running the
 * model on it costs an inference and returns noise, which is the worst of both.
 */
export const MIN_SEMANTIC_QUERY_LENGTH = 3;

/**
 * Hard ceiling on what will be embedded, in characters.
 *
 * gte-small truncates at 512 tokens anyway, so anything past roughly this length
 * is not read by the model — it is only paid for. The catalog's own search box
 * caps at 120 characters (`parseCatalogQuery`), so this bound is for direct
 * callers.
 */
export const MAX_QUERY_CHARS = 512;

/** True when `value` is a finite-numeric vector of exactly the right width. */
export function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSION &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}
