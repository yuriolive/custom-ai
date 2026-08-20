/**
 * Where a model came from (§1.2), as one line the page can render.
 *
 * A fine-tune is its OWN model with a `parent_id`, never a variant of the model
 * it was trained from — the schema is built on that rule (20260820000100) and
 * this is the line that makes it visible. Without it, `SomeLab/Qwen3-8B-Uncensored`
 * reads as an original, and the model that did the work goes uncredited on the
 * page that sells its derivative.
 *
 * ── The four states, and why none of them is blank ──────────────────────────
 * The mockup for this line reads `based on ↑ nothing (root)`, and the reason it
 * says something rather than nothing is that BLANK IS AMBIGUOUS: an original and
 * an unresolved listing would render identically, and they are opposite claims.
 * "This model was trained from scratch" and "nobody has checked what this model
 * was trained from" cannot share a rendering. So:
 *
 *   unresolved  no base model attached yet (the normal state until #25's
 *               cascade runs). We do not know. Say that.
 *   root        a base model with no parent. An original, as far as the
 *               catalog knows.
 *   derived     a parent row, named and linked.
 *   orphaned    a parent id whose row is not readable. Not reachable through
 *               RLS today, and handled anyway: `parent_id` is
 *               ON DELETE SET NULL, so the honest answer is that we lost it.
 *
 * Pure and dependency-free so `node --test` can load it; `.ts` extensions on the
 * relative imports for that reason (see the header of `format.ts`).
 */

import type { BaseModelInfo, ParentModelInfo } from "./types.ts";

export type Lineage =
  | { kind: "unresolved"; note: string }
  | { kind: "root"; note: string }
  | { kind: "orphaned"; note: string }
  | {
      kind: "derived";
      parentName: string;
      note: string;
      /**
       * What to search the catalog for to see the parent's own listings, or null
       * when it has none.
       *
       * Null is the honest state and not a missing feature: a base model has no
       * page of its own — the platform's addressable unit is a LISTING
       * (`creator-handle/model-slug`), and `base_models.slug` is a weights
       * publisher and a model name, which resolves to nothing. So the only
       * destination available is a catalog search, and linking to one that
       * returns zero rows is worse than not linking: it reads as a broken page
       * rather than as a model nobody here serves.
       */
      searchQuery: string | null;
    };

/**
 * The lineage of the model this page is about.
 *
 * `parent` is only consulted when the model claims one, so a stray parent row
 * cannot invent a lineage for a root model.
 */
export function lineageOf(model: BaseModelInfo | null, parent: ParentModelInfo | null): Lineage {
  if (!model) {
    return {
      kind: "unresolved",
      note:
        "The platform has not matched these weights to a known model yet, so their " +
        "lineage is unknown — not absent.",
    };
  }

  if (model.parentId === null) {
    return {
      kind: "root",
      // The note QUALIFIES the summary rather than restating it. A root here
      // means no parent has been RECORDED, which is a claim about this catalog
      // and not about the weights' training history — and that distinction is
      // the only thing this second line is for.
      note: "As far as this catalog knows: no parent model has been recorded for them.",
    };
  }

  if (!parent) {
    return {
      kind: "orphaned",
      note:
        "These weights are derived from another model, whose record is no longer " +
        "readable here.",
    };
  }

  return {
    kind: "derived",
    parentName: parent.displayName,
    // Again a qualification, not a restatement: the summary already names the
    // parent, so this line carries the §1.2 rule (a fine-tune's output is its
    // own, never its parent's) and whether the parent can be shopped for here.
    note:
      parent.listingCount > 0
        ? "A fine-tune, merge or adapter — its output is its own, not its parent's. The parent is served here too."
        : "A fine-tune, merge or adapter — its output is its own, not its parent's. Nobody serves the parent here.",
    // Searched by DISPLAY NAME, not by `slug`. The slug's first segment is the
    // weights publisher, and searching `qwen/qwen3-8b` tokenizes the publisher
    // into the query, which narrows a catalog search to one lab's listings of a
    // model several labs may re-publish.
    searchQuery: parent.listingCount > 0 ? parent.displayName : null,
  };
}

/**
 * The lead-in the page prints before the parent's name: `based on`.
 *
 * A constant rather than inline copy because the root and unresolved states have
 * to read as answers to the SAME question, and they only do if the question is
 * asked in one place.
 */
export const LINEAGE_PREFIX = "based on";

/** The short right-hand side of the line, in every state. */
export function lineageSummary(lineage: Lineage): string {
  switch (lineage.kind) {
    case "unresolved":
      return "an unrecorded model";
    case "root":
      // Matches the mockup's `nothing (root)`, spelled out: this is the one
      // state where the interesting fact is the absence.
      return "nothing — these are original weights";
    case "orphaned":
      return "a model no longer listed here";
    case "derived":
      return lineage.parentName;
  }
}
