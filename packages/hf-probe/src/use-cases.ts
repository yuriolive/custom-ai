/**
 * LAYER A of marketplace discovery (#28, §4.1): a Hugging Face repo's metadata →
 * the closed `base_models.use_cases` vocabulary.
 *
 * ── Why the vocabulary is closed ────────────────────────────────────────────
 * An open tag cloud degrades into synonyms. `coding`, `code` and `programming`
 * are one facet written three ways, and the moment they coexist the counted tabs
 * are all wrong: three tabs, each with a third of the rows, and no way for a
 * shopper to select "models for code". The set below is the one the database
 * CHECK enforces (`base_models_use_cases_vocab`, 20260820000100) and the one the
 * catalog renders as tabs (#26). It is duplicated in
 * `components/marketplace/types.ts` as `MODEL_CATEGORIES` for the UI's tab
 * ORDER; `grouped-catalog.test.ts` asserts that list is a subset of the CHECK.
 *
 * ── Why this is deterministic and not a model call ──────────────────────────
 * This runs once per base model at deploy time and its output is a FACET: it
 * decides which tab a model appears under, and a tab that moves between deploys
 * because a sampler rolled differently is not a facet, it is noise. Rules are
 * also auditable — a creator can be told exactly why their model is filed under
 * `roleplay`, which is not a sentence anyone can write about a classifier.
 *
 * ── Precision over recall, deliberately ─────────────────────────────────────
 * A missing tag costs a model one route to being found; a WRONG tag puts it in
 * front of someone who wanted something else and makes every count on that tab a
 * small lie. So every rule below fires on an explicit signal — a Hugging Face
 * tag, a pipeline tag, a declared architecture fact — or on a phrase in the model
 * card that is not ambiguous in context. Nothing is inferred from the model's
 * name alone except where the name IS the claim (`-uncensored`, `-coder`).
 */

/** The closed vocabulary, in the order the schema's CHECK lists it. */
export const USE_CASES = [
  "code",
  "reasoning",
  "chat",
  "roleplay",
  "uncensored",
  "multilingual",
  "vision",
  "long-context",
  "tool-use",
  "math",
  "embeddings",
  "summarization",
] as const;

export type UseCase = (typeof USE_CASES)[number];

/** Everything the classifier reads. Every field is optional; absence is not a signal. */
export interface UseCaseInput {
  /** The repo's tag list, verbatim from the HF API (`model.tags`). */
  tags?: readonly string[] | null;
  /** `model.pipeline_tag` — the single task HF itself files the repo under. */
  pipelineTag?: string | null;
  /** `owner/Name`, or the model's display name. Used only where the name IS the claim. */
  repoSlug?: string | null;
  /** README/model-card body. Read for phrases, never for adjectives. */
  cardText?: string | null;
  /**
   * `max_position_embeddings` from the config or the GGUF header — the
   * ARCHITECTURE's context, not the listing's `context_length`, which is a
   * creator's deployment choice and would make one model's use cases depend on
   * how someone else deployed it.
   */
  maxPositionEmbeddings?: number | null;
}

/**
 * A context this long is a capability rather than a default.
 *
 * 128k, because it is the first rung at which a shopper's question changes from
 * "does it fit my prompt" to "can I put a codebase in it" — and because the
 * catalog's own context rail already breaks at 128000 (`CONTEXT_STEPS`). Below
 * it, `long-context` would be true of most current models and would therefore
 * distinguish nothing.
 */
export const LONG_CONTEXT_TOKENS = 131_072;

/**
 * HF pipeline tags that decide a use case ON THEIR OWN.
 *
 * These are structured metadata, not prose: the repo owner picked one task from
 * a fixed list, and HF's own UI files the repo under it. `text-generation` is
 * NOT here — it covers every instruct model ever published and would tag the
 * whole catalog `chat`.
 */
const PIPELINE_USE_CASES: Readonly<Record<string, readonly UseCase[]>> = {
  "image-text-to-text": ["vision"],
  "visual-question-answering": ["vision"],
  "image-to-text": ["vision"],
  "video-text-to-text": ["vision"],
  "feature-extraction": ["embeddings"],
  "sentence-similarity": ["embeddings"],
  summarization: ["summarization"],
  translation: ["multilingual"],
  "text2text-generation": ["summarization"],
};

/**
 * Hugging Face tags that decide a use case on their own, lowercased.
 *
 * A tag is a deliberate act by the repo owner, which is why a single one is
 * enough here and a single word in a README is not.
 */
const TAG_USE_CASES: Readonly<Record<string, readonly UseCase[]>> = {
  code: ["code"],
  "code-generation": ["code"],
  coding: ["code"],
  programming: ["code"],
  reasoning: ["reasoning"],
  "chain-of-thought": ["reasoning"],
  conversational: ["chat"],
  roleplay: ["roleplay"],
  "role-play": ["roleplay"],
  rp: ["roleplay"],
  uncensored: ["uncensored"],
  abliterated: ["uncensored"],
  unaligned: ["uncensored"],
  multilingual: ["multilingual"],
  translation: ["multilingual"],
  vision: ["vision"],
  multimodal: ["vision"],
  vlm: ["vision"],
  "long-context": ["long-context"],
  "function-calling": ["tool-use"],
  "tool-use": ["tool-use"],
  "tool-calling": ["tool-use"],
  agent: ["tool-use"],
  agentic: ["tool-use"],
  math: ["math"],
  mathematics: ["math"],
  gsm8k: ["math"],
  embeddings: ["embeddings"],
  "sentence-transformers": ["embeddings"],
  "text-embeddings-inference": ["embeddings"],
  summarization: ["summarization"],
};

/**
 * Model-card phrases, as anchored regexes.
 *
 * PHRASES, not words. `math` matches "mathematical notation is rendered below";
 * `trained on math` does not match anything but a claim about the model. Every
 * pattern here is one somebody wrote to describe what the model DOES.
 */
const CARD_PATTERNS: readonly { readonly pattern: RegExp; readonly useCase: UseCase }[] = [
  { pattern: /\b(code|program)\w*\s+(generation|completion|assistant|model)\b/, useCase: "code" },
  { pattern: /\bfill[- ]in[- ]the[- ]middle\b/, useCase: "code" },
  { pattern: /\b(step[- ]by[- ]step|chain[- ]of[- ]thought)\s+reasoning\b/, useCase: "reasoning" },
  { pattern: /\breasoning\s+(model|traces|capabilit)/, useCase: "reasoning" },
  { pattern: /\b(role[- ]?play|character\s+card|persona)\w*\b/, useCase: "roleplay" },
  { pattern: /\b(uncensored|abliterat\w+|without\s+refusals?)\b/, useCase: "uncensored" },
  { pattern: /\b(function|tool)\s+call(ing|s)?\b/, useCase: "tool-use" },
  {
    pattern: /\b(math(ematical)?|arithmetic)\s+(reasoning|problems?|benchmarks?)\b/,
    useCase: "math",
  },
  { pattern: /\btrained\s+on\s+math\b/, useCase: "math" },
  { pattern: /\b(summariz|summaris)\w+\s+(task|model|capabilit)/, useCase: "summarization" },
  { pattern: /\b(image|visual|document)\s+understanding\b/, useCase: "vision" },
];

/** ISO-639-1 codes HF uses as language tags, minus `en`. Two of these means multilingual. */
const LANGUAGE_TAG = /^[a-z]{2}$/;

/**
 * Names that ARE the claim.
 *
 * A repo called `…-Uncensored-GGUF` is making a statement about the weights in
 * its own identity — that is not an inference from prose, it is the publisher's
 * own label, and it is the one place a name is trusted.
 */
const NAME_PATTERNS: readonly { readonly pattern: RegExp; readonly useCase: UseCase }[] = [
  { pattern: /uncensored|abliterated/, useCase: "uncensored" },
  { pattern: /\bcoder?\b|-coder/, useCase: "code" },
  { pattern: /\bmath\b/, useCase: "math" },
  { pattern: /\bvl\b|-vl-|vision/, useCase: "vision" },
  { pattern: /\bembed(ding)?\b|\bgte\b|\bbge\b/, useCase: "embeddings" },
];

/** Every use case a repo's declared metadata states outright. */
function fromDeclaredMetadata(tags: readonly string[], pipelineTag: string | undefined): UseCase[] {
  const found: UseCase[] = [];

  for (const tag of tags) found.push(...(TAG_USE_CASES[tag] ?? []));
  if (pipelineTag) found.push(...(PIPELINE_USE_CASES[pipelineTag] ?? []));

  // Two or more declared languages is the signal — not the presence of one
  // non-English tag, which is how a monolingual Portuguese model is tagged and
  // which `multilingual` would misdescribe.
  const languages = new Set(tags.filter((tag) => LANGUAGE_TAG.test(tag)));
  if (languages.size >= 2) found.push("multilingual");

  return found;
}

/** Every use case a body of text claims, by pattern. */
function fromText(
  text: string,
  patterns: readonly { readonly pattern: RegExp; readonly useCase: UseCase }[],
): UseCase[] {
  if (!text) return [];
  return patterns.filter(({ pattern }) => pattern.test(text)).map(({ useCase }) => useCase);
}

/**
 * A repo's metadata → its use cases, deduplicated and in vocabulary order.
 *
 * The ORDER is `USE_CASES` order and not discovery order, so two probes of the
 * same repo produce the same array and a re-resolution does not show up as a
 * change. `[]` is a legitimate answer and the honest one for a model whose card
 * says nothing: an empty `use_cases` puts the model on the `All` tab and on no
 * other, which is exactly where a model nobody has described belongs.
 */
export function classifyUseCases(input: UseCaseInput): UseCase[] {
  const tags = (input.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);

  const found = new Set<UseCase>([
    ...fromDeclaredMetadata(tags, input.pipelineTag?.toLowerCase().trim()),
    // A name is read only where the name IS the claim; the card is read for
    // phrases, and BOUNDED, because a model card is occasionally a megabyte of
    // benchmark tables and the claims are at the top.
    ...fromText((input.repoSlug ?? "").toLowerCase(), NAME_PATTERNS),
    ...fromText((input.cardText ?? "").slice(0, 20_000).toLowerCase(), CARD_PATTERNS),
  ]);

  // Structural, and therefore the most reliable signal here: this one is a fact
  // about the architecture rather than a claim about the weights.
  const positions = input.maxPositionEmbeddings;
  if (typeof positions === "number" && positions >= LONG_CONTEXT_TOKENS) {
    found.add("long-context");
  }

  // An embedding model is not a chat model, and a repo tagged both is tagged
  // wrong. `embeddings` wins because it is the narrower claim and because the
  // gateway cannot serve chat completions from one anyway.
  if (found.has("embeddings")) {
    found.delete("chat");
    found.delete("roleplay");
    found.delete("reasoning");
  }

  return USE_CASES.filter((useCase) => found.has(useCase));
}
