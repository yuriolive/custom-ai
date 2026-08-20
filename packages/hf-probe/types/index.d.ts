/**
 * PUBLIC TYPE SURFACE for `@nexus/hf-probe`.
 *
 * Additive only: no runtime code, no reclassification, no second
 * implementation of anything in `src/`. This file exists so a consumer
 * compiling under DIFFERENT strictness can import the package without pulling
 * its sources into their program.
 *
 * WHY. `packages/hf-probe/tsconfig.json` sets `noUncheckedIndexedAccess: false`
 * and `exactOptionalPropertyTypes: false`; the Next app's root tsconfig sets
 * neither. Importing the package from `app/` therefore adds `src/*.ts` to the
 * app's program and reports 20 errors in code that is green under its own
 * project and has 65 passing tests:
 *
 *   packages/hf-probe/src/classify.ts(147,16): TS18048  'prefix' is possibly 'undefined'
 *   packages/hf-probe/src/hf.ts(111,12):       TS2322   'string | undefined' not assignable
 *   packages/hf-probe/src/probe.ts(192,44):    TS2345   'string | undefined' not assignable
 *
 * That is measured `npx tsc --noEmit` output, not a prediction.
 *
 * The `types` condition in package.json's `exports` points here, so TypeScript
 * reads this and the bundler still resolves `./src/index.ts` for runtime —
 * `types` is a TS-only condition and no bundler honours it.
 *
 * NOTE FOR THE NEXT EDITOR OF `src/`: this file is hand-written and must be
 * kept in step. `lib/studio/server/probe.ts` maps every field it reads onto its
 * own type and validates the numbers the capacity solver depends on, so a drift
 * surfaces as a probe reporting missing architecture rather than as a silently
 * wrong capacity plan — but that is a backstop, not an excuse.
 *
 * The types below are transcribed from `packages/shared/types.ts`, which is
 * FROZEN (docs/CONTRACTS.md).
 */

export type WeightsFormat = "gguf" | "safetensors" | "awq" | "gptq" | "unknown";

/** Only "model" is deployable. See FR-DEP-041a. */
export type GgufRole = "model" | "draft" | "mmproj" | "lora" | "unknown";

/** Derived from WeightsFormat — never chosen by a user. See FR-DEP-060. */
export type ModelRuntime = "vllm" | "llamacpp";

export interface HfFile {
  path: string;
  sizeBytes: number;
}

export interface ModelVariant {
  /** Stable id: `${family ?? "base"}:${quantTag ?? "native"}` */
  id: string;
  /** e.g. "Q4_K_M", "IQ4_XS", "AWQ". null = repo-native precision. */
  quantTag: string | null;
  /** Variants in different families are DIFFERENT MODELS (FR-DEP-041b). */
  family: string | null;
  role: GgufRole;
  /** All files for this variant. Split GGUF => every shard (FR-DEP-042). */
  files: string[];
  /** Sum over `files`. Never a single shard's size. */
  weightsBytes: number;
  /** Bytes read per decoded token. Equals weightsBytes for dense models. */
  activeWeightsBytes: number;
  bitsPerWeight: number | null;
  /** Creator-facing label, e.g. "Balanced". Never the raw quant tag. */
  qualityLabel: string;
  deployable: boolean;
  excludedReason?: string;
}

export interface ModelArchitecture {
  /** TOTAL block count. NOT the KV multiplier on a hybrid model. */
  nLayers: number;
  /** Blocks that actually hold a growing KV cache. */
  nAttentionLayers: number;
  fullAttentionInterval: number | null;
  /** GQA count — NOT nAttentionHeads. */
  nKvHeads: number;
  nAttentionHeads: number;
  hiddenSize: number;
  /** From `key_length` (GGUF) or `head_dim` (config.json). */
  headDim: number;
  maxPositionEmbeddings: number | null;
  /** Per-sequence SSM state. CONSTANT — does NOT grow with context. */
  ssm: {
    stateSize: number;
    innerSize: number;
    groupCount: number;
    convKernel: number;
  } | null;
  architecture: string | null;
  source: "config.json" | "gguf-header";
}

export interface HfProbeResult {
  repoSlug: string;
  revision: string;
  exists: boolean;
  isPrivate: boolean;
  isGated: boolean;
  libraryName: string | null;
  weightsFormat: WeightsFormat;
  runtime: ModelRuntime;
  variants: ModelVariant[];
  /** Non-deployable companions, kept for later use (FR-DEP-046). */
  companions: { role: GgufRole; file: string; sizeBytes: number }[];
  architecture: ModelArchitecture | null;
  /** Set when architecture could not be determined — then REJECT, never guess. */
  architectureError?: string;
  /** Parents the repo DECLARES, card data first. The only auto-link signals. */
  declaredBaseModels: DeclaredBaseModel[];
  /** The licence THIS repo carries — advisory about the weights beneath it. */
  license: RepoLicense | null;
}

export interface ProbeOptions {
  /** Git revision. Default "main". */
  revision?: string;
  hfToken?: string;
  endpoint?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Skip every network read of model architecture (offline unit tests). */
  skipArchitecture?: boolean;
  maxHeaderBytes?: number;
  initialHeaderBytes?: number;
  /** File list override — how the committed fixture is replayed offline. */
  files?: HfFile[];
}

/** The single entry point the deployment form calls. FR-DEP-040 … FR-DEP-047. */
export function probeRepo(slug: string, opts?: ProbeOptions): Promise<HfProbeResult>;

// ─── Tool-calling capability (FR-TOOL-003) ───────────────────────────────────

export type ToolSupportSource = "chat_template_file" | "tokenizer_config" | "gguf_header";

export interface ToolSupportResult {
  /** true / false measured; null when no template could be read at all. */
  supported: boolean | null;
  source: ToolSupportSource | null;
  /** Why `supported` is null. Advisory — provisioning proceeds either way. */
  error?: string;
}

export interface ToolSupportOptions {
  revision?: string;
  hfToken?: string;
  endpoint?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Repo file paths from an earlier probe; skips fetches that would 404. */
  files?: string[];
  /** Repo-relative GGUF file to read `tokenizer.chat_template` from. */
  ggufFile?: string | null;
  maxBytes?: number;
}

/**
 * Read whichever chat template the repo ships and decide whether it can render
 * tool definitions. Never throws; an unreadable template is `{supported: null}`,
 * which downstream MUST treat as unknown rather than as false.
 */
export function resolveToolSupport(
  slug: string,
  opts?: ToolSupportOptions,
): Promise<ToolSupportResult>;

/** The pure half, for a template already in hand. null = absent or blank. */
export function detectToolSupport(template: string | null | undefined): boolean | null;

// ─── Base-model identity & licence (#25) ─────────────────────────────────────

export type BaseModelRelation = "quantized" | "finetune" | "merge" | "adapter";

export type BaseModelSignal = "card_data" | "gguf_header" | "fingerprint" | "name" | "manual";

/** Mirrors `public.commercial_hosting`. `unknown` never auto-publishes. */
export type CommercialHosting = "allowed" | "conditional" | "prohibited" | "unknown";

export interface RepoLicense {
  id: string | null;
  name: string | null;
  url: string | null;
  commercialHosting: CommercialHosting;
}

export interface DeclaredBaseModel {
  repoSlug: string;
  relation: BaseModelRelation | null;
  source: "card_data" | "gguf_header";
}

/** NEVER an identity: a fine-tune matches its parent on every field. */
export interface Fingerprint {
  architecture: string | null;
  nLayers: number | null;
  nAttentionHeads: number | null;
  nKvHeads: number | null;
  headDim: number | null;
  hiddenSize: number | null;
}

export interface BaseModelCandidate {
  id: string;
  slug: string;
  displayName: string;
  fingerprint: Fingerprint | null;
}

export interface ScoredCandidate extends BaseModelCandidate {
  confidence: number;
  matchedOn: ("fingerprint" | "name")[];
  relationHint: "quantized" | "finetune";
}

export interface IdentityInput {
  repoSlug: string;
  declared: DeclaredBaseModel[];
  fingerprint: Fingerprint | null;
  candidates?: BaseModelCandidate[];
}

export interface BaseModelIdentity {
  /** True only for a DECLARED signal — card data or the GGUF header. */
  autoLink: boolean;
  signal: BaseModelSignal | null;
  relation: BaseModelRelation | null;
  parentRepoSlug: string | null;
  /** True when THIS repo is its own model whose parent is `parentRepoSlug`. */
  ownModel: boolean;
  confidence: number;
  /** Populated only when nothing was declared. Never auto-applied. */
  suggestions: ScoredCandidate[];
  reason: string;
}

/** The cascade. The only function allowed to decide that a repo links. */
export function resolveBaseModelIdentity(input: IdentityInput): BaseModelIdentity;

export function scoreCandidates(
  input: { repoSlug: string; fingerprint: Fingerprint | null },
  candidates: BaseModelCandidate[],
): ScoredCandidate[];

export function repoSlugFromRef(ref: string | null | undefined): string | null;

/** `publisher/name` for a `base_models` row, from a Hub repo slug. */
export function baseModelSlugFromRepo(repoSlug: string): string | null;

export function normalizeModelName(name: string): string;

export function nameTokens(name: string): string[];

export function nameSimilarity(a: string, b: string): number;

export function normalizeRelation(raw: unknown): BaseModelRelation | null;

export function fingerprintMatches(a: Fingerprint | null, b: Fingerprint | null): boolean;

export function commercialHostingFor(licenseId: string | null | undefined): CommercialHosting;

export function normalizeLicenseId(raw: unknown): string | null;

export function strictest(a: CommercialHosting, b: CommercialHosting): CommercialHosting;

export interface HfCardData {
  base_model?: string | string[];
  base_model_relation?: string;
  license?: string | string[];
  license_name?: string;
  license_link?: string;
  tags?: string[];
  pipeline_tag?: string;
  [k: string]: unknown;
}

export function licenseFromCardData(
  cardData: HfCardData | null | undefined,
  repo?: { repoSlug?: string; revision?: string; endpoint?: string },
): RepoLicense | null;

export interface HfModelInfo {
  id?: string;
  sha?: string;
  private?: boolean;
  gated?: false | "auto" | "manual" | string;
  library_name?: string | null;
  pipeline_tag?: string | null;
  siblings?: { rfilename: string; size?: number }[];
  config?: Record<string, unknown>;
  /** Only present because getModelInfo asks for `?full=true`. */
  cardData?: HfCardData | null;
  safetensors?: { total?: number; parameters?: Record<string, number> } | null;
  tags?: string[];
  [k: string]: unknown;
}

export interface HfClientOptions {
  endpoint?: string;
  hfToken?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface HfResponse<T> {
  status: number;
  body: T | null;
  error: string | null;
}

/** `GET /api/models/{slug}?full=true` — the request that carries `cardData`. */
export function getModelInfo(
  slug: string,
  opts?: HfClientOptions,
): Promise<HfResponse<HfModelInfo>>;
