/**
 * What actually gets embedded, for a base model and for a query.
 *
 * Pure, and its own module, so `node --test` can assert on the exact string. The
 * document is not an implementation detail: it IS the semantic index. Change it
 * and every stored vector is stale, which is invisible — the arm keeps returning
 * results, they are just answers to a slightly different question.
 */

import { MAX_QUERY_CHARS } from "./dimension.ts";

/** The `base_models` columns the document is built from. */
export type BaseModelDocumentInput = {
  display_name: string | null;
  slug: string | null;
  family: string | null;
  summary: string | null;
  use_cases: string[] | null;
  parameter_count: number | string | null;
};

/** `27000000000` → `27B`. Billions, because that is the unit a shopper reads. */
function formatParameters(count: number | string | null): string | null {
  const n = typeof count === "string" ? Number(count) : count;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const billions = n / 1_000_000_000;
  if (billions >= 1) {
    // One decimal, and only when it says something: `8B`, not `8.0B`.
    const rounded = Math.round(billions * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}B parameters`;
  }
  return `${Math.round(n / 1_000_000)}M parameters`;
}

/**
 * One base model → the text whose embedding is stored on the row.
 *
 * ONE DOCUMENT PER BASE MODEL, never per listing. Six quantizations of the same
 * weights embedded six times cost six times as much and put six near-duplicate
 * vectors in the top-k, where they crowd out every other model in the arm — the
 * result is a search that answers "Qwen3 8B" six times and shows nothing else.
 *
 * The USE CASES ARE IN THE DOCUMENT, spelled as a sentence rather than as a tag
 * list. That is the join between the two layers: a shopper who types
 * `write unit tests` shares no lexeme with `Qwen3 Coder 8B`, but `used for code`
 * sits in the same neighbourhood as their query, so Layer A's closed vocabulary
 * is what gives Layer B something to be near. Layer B without it would be
 * matching a query about a task against a document that only names a product.
 *
 * Nothing about hardware, price, speed or quantization is here. Those are
 * properties of a LISTING, they change without the weights changing, and every
 * one of them would put a stale vector on the row the next time a creator edits
 * a price.
 */
export function baseModelDocument(row: BaseModelDocumentInput): string {
  const parts: string[] = [];

  if (row.display_name) parts.push(row.display_name);
  // The slug carries the WEIGHTS PUBLISHER (`qwen/qwen3-8b`), which is a real
  // retrieval signal: people search for "a mistral model" as often as for a
  // model by name.
  if (row.slug) parts.push(row.slug.replace(/[/_-]+/g, " "));
  if (row.family) parts.push(row.family);

  const params = formatParameters(row.parameter_count);
  if (params) parts.push(params);

  const useCases = (row.use_cases ?? []).filter((u) => typeof u === "string" && u.length > 0);
  if (useCases.length > 0) {
    parts.push(`Used for ${useCases.map((u) => u.replace(/-/g, " ")).join(", ")}.`);
  }

  if (row.summary) parts.push(row.summary);

  return parts.join(". ").replace(/\.\s*\./g, ".").trim();
}

/**
 * A search box's text → what is handed to the model.
 *
 * Collapsed whitespace and a hard length bound, nothing else: no lowercasing, no
 * stemming, no stop-word removal. Those are LEXICAL normalizations — `to_tsvector`
 * does them for the other arm, and doing them here would hand the embedding model
 * text no human ever writes, which is exactly what it was not trained on.
 */
export function normalizeQuery(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}
