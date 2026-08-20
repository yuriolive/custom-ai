import "server-only";

/**
 * Fetching the model card. The parsing is `lib/studio/card.ts`, which is pure
 * and unit-tested; this file is the network boundary and nothing else.
 */

import { factsFromCard, type CardFacts } from "../card";

/** Fetch and extract. Never throws — a failure is simply "nothing was learned". */
export async function fetchCardFacts(
  slug: string,
  revision: string,
  opts: { hfToken?: string; signal?: AbortSignal } = {},
): Promise<CardFacts> {
  const empty: CardFacts = { description: null, license: null, declaredBaseModels: [] };
  const url = `https://huggingface.co/${slug}/raw/${encodeURIComponent(revision)}/README.md`;
  try {
    const response = await fetch(url, {
      headers: opts.hfToken ? { authorization: `Bearer ${opts.hfToken}` } : {},
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return empty;
    }
    // A model card is prose. Anything of this size is not one, and reading it
    // in full would hand a route worker an unbounded body.
    const text = (await response.text()).slice(0, 200_000);
    return factsFromCard(text, { repoSlug: slug, revision });
  } catch {
    return empty;
  }
}
