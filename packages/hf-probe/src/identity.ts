/**
 * Base-model identity — which MODEL a repository is a variant of.
 *
 * PURE. No fetch, no clock, no database: everything here is a function of the
 * probe result and of candidate rows the caller already loaded. That is what
 * makes the one rule this file exists to enforce testable.
 *
 * THE RULE: a repo may be auto-linked to a base model ONLY on a signal the
 * repository itself DECLARES — `cardData.base_model` (signal 1) or the GGUF
 * header's `general.base_model.*` (signal 2). An architecture fingerprint
 * (signal 3) and a normalized name (signal 4) may SUGGEST and never link,
 * because a fine-tune has an identical fingerprint to its parent — same layers,
 * same heads, same vocab — so grouping on architecture alone merges `Qwen3-8B`
 * with `SomeLab/Qwen3-8B-Uncensored` and serves the fine-tune's output under
 * the base model's name.
 *
 * `base_model_relation` answers the same question without asking anybody:
 * `quantized` means the repo serves the parent's weights and belongs UNDER its
 * row; `finetune` / `merge` / `adapter` mean the repo is its own model, with the
 * declared parent as its `parent_id`.
 */

import type { BaseModelRelation, BaseModelSignal, DeclaredBaseModel } from "../../shared/types.ts";

// ─── repo references ────────────────────────────────────────────────────────

/** `owner/name`, both segments non-empty and free of path separators. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `owner/name` out of whatever a declaration carries: a bare slug, a Hub URL,
 * a `hf.co` short URL, or any of those with a trailing `/tree/main`.
 *
 * Anything that does not resolve to exactly two Hub path segments returns null
 * rather than a guess — a wrong parent is worse than no parent, because it is
 * the one a shopper reads as provenance.
 */
export function repoSlugFromRef(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  let text = ref.trim();
  if (text.length === 0) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "huggingface.co" && host !== "hf.co") return null;
    text = url.pathname;
  }

  const segments = text.split("/").filter((s) => s.length > 0);
  // `/models/owner/name` and `/owner/name` are both written in the wild.
  const start = segments[0] === "models" ? 1 : 0;
  const owner = segments[start];
  const name = segments[start + 1];
  if (!owner || !name) return null;
  const slug = `${owner}/${name}`;
  return SLUG_RE.test(slug) ? slug : null;
}

/** HF's `base_model_relation` vocabulary, plus the spellings seen in the wild. */
export function normalizeRelation(raw: unknown): BaseModelRelation | null {
  if (typeof raw !== "string") return null;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (v === "quantized" || v === "quantization" || v === "quant") return "quantized";
  if (v === "finetune" || v === "fine-tune" || v === "finetuned" || v === "fine-tuned") {
    return "finetune";
  }
  if (v === "merge" || v === "merged") return "merge";
  if (v === "adapter" || v === "lora" || v === "peft") return "adapter";
  return null;
}

// ─── names ──────────────────────────────────────────────────────────────────

/**
 * Tokens that describe the PACKAGING, not the model. Stripping them is what
 * makes `Qwen3-8B-GGUF`, `Qwen3-8B-i1-GGUF` and `Qwen3-8B` one name.
 *
 * `deriveBaseName` in classify.ts does the same job for FILENAMES inside one
 * repo; this does it for repo names across repos, which is a different input
 * (no quant tag position to lean on) and therefore a different function.
 */
const PACKAGING_TOKENS = new Set([
  "gguf",
  "ggml",
  "awq",
  "gptq",
  "exl2",
  "exl3",
  "mlx",
  "onnx",
  "i1",
  "imat",
  "imatrix",
  "quantized",
  "quant",
  "quants",
  "weights",
  "hf",
  "fp8",
  "fp16",
  "bf16",
  "int8",
  "int4",
  "4bit",
  "8bit",
]);

/**
 * A llama.cpp quant tag anywhere in a repo name, INCLUDING its underscores:
 * `Q4_K_M` has to be removed before the name is split, because splitting first
 * leaves `k` and `m` behind as tokens and `Qwen3-8B-Q4_K_M` stops matching
 * `Qwen3-8B`. The authority on the tag vocabulary is quant.ts; this is the
 * looser repo-name form of the same shape, and it is deliberately anchored to a
 * separator so it cannot eat the `q` of a model called `Qwen`.
 */
const QUANT_TAG_IN_NAME_RE = /(^|[-_.\s])(iq|q)\d+(?:_[a-z0-9]+)*(?=[-_.\s]|$)/gi;

/** The same tag as a standalone token, for a name that was split elsewhere. */
const QUANT_TOKEN_RE = /^(iq|q)\d+(_[a-z0-9]+)*$/i;

/** Splits a repo name into comparable tokens, packaging and quant tags gone. */
export function nameTokens(name: string): string[] {
  return name
    .replace(QUANT_TAG_IN_NAME_RE, "$1")
    .split(/[-_.\s/]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && !PACKAGING_TOKENS.has(t) && !QUANT_TOKEN_RE.test(t));
}

/** The comparison key: tokens joined, separators gone. `null` for an empty name. */
export function normalizeModelName(name: string): string {
  return nameTokens(name).join("-");
}

/**
 * 1 for the same model, 0 for unrelated, and something in between for a name
 * that CONTAINS another — which is the fine-tune shape (`Qwen3-8B-Uncensored`
 * against `Qwen3-8B`) and is exactly the case that must not score 1.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left.join("-") === right.join("-")) return 1;

  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  const isPrefix = shorter.every((t, i) => longer[i] === t);

  const overlap = shorter.filter((t) => longer.includes(t)).length;
  const dice = (2 * overlap) / (left.length + right.length);
  // A true prefix is a stronger claim than the same tokens scattered, but it is
  // still the fine-tune shape, so it is capped below 1 on purpose.
  return isPrefix ? Math.min(0.95, 0.6 + dice * 0.35) : dice;
}

/** The `publisher/name` a base-model row is keyed by, from a Hub repo slug. */
export function baseModelSlugFromRepo(repoSlug: string): string | null {
  const slug = repoSlugFromRef(repoSlug);
  if (slug === null) return null;
  const [owner, name] = slug.split("/");
  const publisher = sanitizeSegment(owner);
  const model = sanitizeSegment(nameTokens(name).join("-") || name);
  if (publisher === null || model === null) return null;
  return `${publisher}/${model}`;
}

/** `base_models.slug`'s CHECK: `^[a-z0-9][a-z0-9._-]{0,62}$` per segment. */
function sanitizeSegment(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return cleaned.length > 0 ? cleaned : null;
}

// ─── the fingerprint (signal 3 — SUGGEST ONLY) ──────────────────────────────

/**
 * The shape `base_models` stores for comparison. NEVER an identity: a fine-tune
 * matches its parent on every field of it, which is why nothing in this file
 * links on a fingerprint alone.
 */
export interface Fingerprint {
  architecture: string | null;
  nLayers: number | null;
  nAttentionHeads: number | null;
  nKvHeads: number | null;
  headDim: number | null;
  hiddenSize: number | null;
}

/** True when every field BOTH sides state agrees, and enough of them are stated. */
export function fingerprintMatches(a: Fingerprint | null, b: Fingerprint | null): boolean {
  if (!a || !b) return false;
  if (a.architecture === null || b.architecture === null) return false;
  if (a.architecture.toLowerCase() !== b.architecture.toLowerCase()) return false;

  const fields = ["nLayers", "nAttentionHeads", "nKvHeads", "headDim", "hiddenSize"] as const;
  let compared = 0;
  for (const f of fields) {
    const left = a[f];
    const right = b[f];
    if (left === null || right === null) continue;
    if (left !== right) return false;
    compared++;
  }
  // The architecture string alone is a family name, not a geometry: `qwen3` is
  // shared by 0.6B and 32B. At least the layer/head shape has to be comparable.
  return compared >= 3;
}

// ─── candidates ─────────────────────────────────────────────────────────────

export interface BaseModelCandidate {
  id: string;
  /** `publisher/name` — `base_models.slug`. */
  slug: string;
  displayName: string;
  fingerprint: Fingerprint | null;
}

export interface ScoredCandidate extends BaseModelCandidate {
  /** 0…1. Never high enough to link on its own — see the header. */
  confidence: number;
  matchedOn: ("fingerprint" | "name")[];
  /**
   * What the creator is being asked to confirm: `quantized` when the names are
   * the same model repackaged, `finetune` when this repo's name CONTAINS the
   * candidate's or merely overlaps it.
   */
  relationHint: "quantized" | "finetune";
}

/** Below this a candidate is noise and is not offered at all. */
const SUGGESTION_FLOOR = 0.3;

/** How many candidates a creator is asked to choose between. */
const MAX_SUGGESTIONS = 5;

/**
 * Rank existing base models against a repo. Signals 3 and 4 TOGETHER, because
 * neither is worth showing alone: a fingerprint match with an unrelated name is
 * every model of that architecture, and a name match with a different geometry
 * is a different size of the same family.
 */
export function scoreCandidates(
  input: { repoSlug: string; fingerprint: Fingerprint | null },
  candidates: BaseModelCandidate[],
): ScoredCandidate[] {
  const repoName = input.repoSlug.slice(input.repoSlug.indexOf("/") + 1);
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const candidateName = candidate.slug.slice(candidate.slug.indexOf("/") + 1);
    const byName = Math.max(
      nameSimilarity(repoName, candidateName),
      nameSimilarity(repoName, candidate.displayName),
    );
    const byFingerprint = fingerprintMatches(input.fingerprint, candidate.fingerprint);

    const matchedOn: ("fingerprint" | "name")[] = [];
    if (byFingerprint) matchedOn.push("fingerprint");
    if (byName >= SUGGESTION_FLOOR) matchedOn.push("name");
    if (matchedOn.length === 0) continue;

    // Capped at 0.75: this is a suggestion, and the number is shown next to a
    // radio button the creator has to press. Nothing here reaches "certain".
    // A fingerprint alone clears the floor by a hair — deliberately, because it
    // is a real signal ("something of exactly this geometry exists") and an
    // unrecognisable one ("every fine-tune of it has the same geometry").
    const confidence = Math.min(0.75, byName * 0.6 + (byFingerprint ? 0.35 : 0));
    if (confidence < SUGGESTION_FLOOR) continue;

    scored.push({
      ...candidate,
      confidence: Math.round(confidence * 100) / 100,
      matchedOn,
      relationHint: byName === 1 ? "quantized" : "finetune",
    });
  }

  return scored
    .toSorted((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug))
    .slice(0, MAX_SUGGESTIONS);
}

// ─── the cascade ────────────────────────────────────────────────────────────

export interface IdentityInput {
  /** The repo being deployed, `owner/name`. */
  repoSlug: string;
  /** What the repo declares, strongest source first. */
  declared: DeclaredBaseModel[];
  fingerprint: Fingerprint | null;
  /** Existing base models to score when nothing was declared. */
  candidates?: BaseModelCandidate[];
}

export interface BaseModelIdentity {
  /** True only for signals 1 and 2. */
  autoLink: boolean;
  signal: BaseModelSignal | null;
  relation: BaseModelRelation | null;
  /** The repo whose weights the PARENT row names. */
  parentRepoSlug: string | null;
  /**
   * True when THIS repo is its own model, with `parentRepoSlug` as its parent —
   * a fine-tune, a merge or an adapter. False when the repo is a repackaging of
   * the parent's weights and belongs directly under the parent's row.
   */
  ownModel: boolean;
  confidence: number;
  /** Populated only when nothing was declared. Never auto-applied. */
  suggestions: ScoredCandidate[];
  /** One sentence, for `base_model_match` and for the form. */
  reason: string;
}

const NOTHING: Omit<BaseModelIdentity, "suggestions" | "reason"> = {
  autoLink: false,
  signal: null,
  relation: null,
  parentRepoSlug: null,
  ownModel: false,
  confidence: 0,
};

/**
 * Run the cascade. The ONLY function allowed to decide that a repo links.
 *
 * Relation inference, where a declaration names a parent but not the relation
 * (the usual case in a GGUF header, which has no relation key at all): equal
 * normalized names mean the same weights repackaged — `Qwen3-8B-GGUF` against
 * `Qwen3-8B` — and anything else is treated as DERIVED, i.e. its own model with
 * a parent. That asymmetry is deliberate. Guessing "derived" on a repackaging
 * splits one catalog row into two, which is cosmetic and repairable; guessing
 * "repackaging" on a derivative serves a fine-tune's output under the base
 * model's name, which is the failure this whole file is arranged to prevent.
 */
export function resolveBaseModelIdentity(input: IdentityInput): BaseModelIdentity {
  const self = repoSlugFromRef(input.repoSlug);

  for (const declaration of input.declared) {
    const linked = fromDeclaration(input, declaration, self);
    if (linked !== null) return linked;
  }

  const suggestions = scoreCandidates(
    { repoSlug: input.repoSlug, fingerprint: input.fingerprint },
    input.candidates ?? [],
  );

  return {
    ...NOTHING,
    suggestions,
    reason:
      suggestions.length > 0
        ? "No base model is declared by this repository. An architecture fingerprint and a " +
          "name match suggest candidates, and neither may link on its own — a fine-tune " +
          "matches its parent on every one of them."
        : "No base model is declared by this repository and nothing in the catalog resembles it.",
  };
}

/**
 * One declaration, taken at its word — or `null` when it says nothing usable:
 * an unparseable reference, or a repo naming ITSELF as its own base model.
 */
function fromDeclaration(
  input: IdentityInput,
  declaration: DeclaredBaseModel,
  self: string | null,
): BaseModelIdentity | null {
  const parent = repoSlugFromRef(declaration.repoSlug);
  if (parent === null) return null;
  if (self !== null && parent.toLowerCase() === self.toLowerCase()) return null;

  const signal: BaseModelSignal = declaration.source === "card_data" ? "card_data" : "gguf_header";
  const declaredRelation = normalizeRelation(declaration.relation);

  if (declaredRelation !== null) {
    return {
      autoLink: true,
      signal,
      relation: declaredRelation,
      parentRepoSlug: parent,
      ownModel: declaredRelation !== "quantized",
      // The repository stated both halves. Nothing this path can infer beats it.
      confidence: signal === "card_data" ? 1 : 0.95,
      suggestions: [],
      reason:
        `${parent} is declared as this repository's base model with relation ` +
        `"${declaredRelation}" (${signal.replace("_", " ")}).`,
    };
  }

  const sameName =
    normalizeModelName(input.repoSlug.slice(input.repoSlug.indexOf("/") + 1)) ===
    normalizeModelName(parent.slice(parent.indexOf("/") + 1));

  return {
    autoLink: true,
    signal,
    relation: sameName ? "quantized" : null,
    parentRepoSlug: parent,
    ownModel: !sameName,
    confidence: sameName ? 0.85 : 0.7,
    suggestions: [],
    reason: sameName
      ? `${parent} is declared as this repository's base model and carries the same ` +
        `name, so these are the same weights repackaged.`
      : `${parent} is declared as this repository's base model but names no relation, ` +
        `and the names differ — recorded as a derived model rather than merged into it.`,
  };
}
