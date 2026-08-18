/**
 * Variant classifier — FR-DEP-040 … FR-DEP-042, FR-DEP-045, FR-DEP-060.
 *
 * The ORDER of the pipeline is the requirement, not an implementation detail:
 *
 *   1. exclude non-weight artifacts by extension          (FR-DEP-041c)
 *   2. classify each .gguf by ROLE from filename markers  (FR-DEP-041a)
 *   3. parse the quant tag                                (FR-DEP-041)
 *   4. derive the FAMILY from the filename residue        (FR-DEP-041b)
 *   5. group split shards into ONE variant, summing bytes (FR-DEP-042)
 *   6. size backstop: < 25% of the largest GGUF is quarantined (FR-DEP-041a)
 *
 * Running 3 before 2 is exactly the bug this file exists to prevent: a draft
 * model matches `Q8_0` and a vision projector matches `F16`.
 *
 * Runtime-free: no imports beyond types + quant table. Deno/Node identical.
 */

import type {
  GgufRole,
  HfFile,
  ModelVariant,
  ModelRuntime,
  WeightsFormat,
} from "../../shared/types.ts";
import { matchQuantTag, qualityForTag } from "./quant.ts";

// ─── 1. non-weight artifacts (FR-DEP-041c) ──────────────────────────────────

/** Extensions that are never weights. An imatrix .dat is a quantizer INPUT. */
const NON_WEIGHT_EXTENSIONS = new Set([
  ".dat",
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".gitattributes",
  ".gitignore",
  ".yaml",
  ".yml",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".py",
  ".ipynb",
  ".lock",
  ".log",
  ".csv",
  ".toml",
  ".cfg",
]);

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extensionOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  // ".gitattributes" — a dotfile whose whole name is the extension.
  if (i <= 0) return name.startsWith(".") ? name.toLowerCase() : "";
  return name.slice(i).toLowerCase();
}

export function isNonWeightArtifact(path: string): boolean {
  return NON_WEIGHT_EXTENSIONS.has(extensionOf(path));
}

// ─── 2. role markers (FR-DEP-041a) ──────────────────────────────────────────

/**
 * Spec regexes are `/[-_.]marker[-_.]/`. We test against a stem padded with
 * "-" on both ends so a marker at the very start or end of the filename is
 * still delimited — otherwise `draft-Q8_0.gguf` (no repo prefix) slips through.
 */
const ROLE_PATTERNS: { role: Exclude<GgufRole, "model" | "unknown">; re: RegExp }[] = [
  { role: "draft", re: /[-_.]draft[-_.]/i },
  { role: "mmproj", re: /[-_.](mmproj|vision|clip)[-_.]/i },
  { role: "lora", re: /[-_.](lora|adapter)[-_.]/i },
];

/** Same markers, for stripping them out of the family residue. */
const ROLE_MARKER_STRIP =
  /(?<=[-_. ])(draft|mmproj|vision|clip|lora|adapter)(?=[-_. ])/gi;

export function classifyRole(stem: string): GgufRole {
  const padded = `-${stem}-`;
  for (const { role, re } of ROLE_PATTERNS) if (re.test(padded)) return role;
  return "model";
}

// ─── 5. split shards (FR-DEP-042) ───────────────────────────────────────────

const SHARD_RE = /-(\d{5})-of-(\d{5})$/;

export interface ShardInfo {
  index: number;
  total: number;
}

/** Strips `-00001-of-00003` from a stem. */
export function splitShardSuffix(stem: string): { stem: string; shard: ShardInfo | null } {
  const m = SHARD_RE.exec(stem);
  if (!m) return { stem, shard: null };
  return {
    stem: stem.slice(0, m.index),
    shard: { index: Number(m[1]), total: Number(m[2]) },
  };
}

// ─── 4. base name & family (FR-DEP-041b) ────────────────────────────────────

/** Repo-name suffixes that describe the packaging, not the model. */
const REPO_SUFFIX_RE = /[-_.](gguf|ggml|awq|gptq)$/i;

/**
 * The base model name that every weight file in the repo shares. Preferred
 * source is the repo name itself (minus packaging suffix); if the files don't
 * actually start with it we fall back to their longest common prefix, trimmed
 * back to a separator boundary so we never eat half a token.
 */
export function deriveBaseName(repoSlug: string, stems: string[]): string {
  const repoName = repoSlug.includes("/") ? repoSlug.slice(repoSlug.indexOf("/") + 1) : repoSlug;
  let candidate = repoName;
  for (let prev = ""; prev !== candidate; ) {
    prev = candidate;
    candidate = candidate.replace(REPO_SUFFIX_RE, "");
  }
  const lower = candidate.toLowerCase();
  if (
    candidate.length > 0 &&
    stems.length > 0 &&
    stems.every((s) => s.toLowerCase().startsWith(lower))
  ) {
    return candidate;
  }
  return longestCommonPrefixAtBoundary(stems);
}

function longestCommonPrefixAtBoundary(stems: string[]): string {
  if (stems.length === 0) return "";
  let prefix = stems[0];
  for (const s of stems.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i].toLowerCase() === s[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  // Trim back to the last separator so we don't split a token in half.
  const cut = Math.max(prefix.lastIndexOf("-"), prefix.lastIndexOf("_"), prefix.lastIndexOf("."));
  return cut === -1 ? "" : prefix.slice(0, cut);
}

/** Tokens that carry no family meaning once the quant tag is gone. */
const NOISE_TOKEN_RE = /^(gguf|ggml|weights|model|part)$/i;

/**
 * FAMILY = the filename residue after stripping base name, quant tag, role
 * markers and shard suffix. `null` is the base family.
 */
export function deriveFamily(
  stem: string,
  baseName: string,
  quant: { start: number; end: number } | null,
): string | null {
  let residue = quant ? stem.slice(0, quant.start) + stem.slice(quant.end) : stem;
  residue = `-${residue}-`.replace(ROLE_MARKER_STRIP, "");
  residue = residue.slice(1, -1);
  if (baseName && residue.toLowerCase().startsWith(baseName.toLowerCase())) {
    residue = residue.slice(baseName.length);
  }
  const tokens = residue
    .split(/[-_. ]+/)
    .filter((t) => t.length > 0 && !NOISE_TOKEN_RE.test(t));
  if (tokens.length === 0) return null;
  return tokens.join("-");
}

// ─── weights format & runtime (FR-DEP-060) ──────────────────────────────────

export function deriveRuntime(format: WeightsFormat): ModelRuntime {
  // gguf -> llamacpp; safetensors | awq | gptq -> vllm. "unknown" has no
  // deployable variant anyway; vLLM is the neutral default for the row.
  return format === "gguf" ? "llamacpp" : "vllm";
}

// ─── the classifier ─────────────────────────────────────────────────────────

/** Fraction of the largest GGUF below which a candidate is quarantined. */
export const COMPANION_SIZE_FRACTION = 0.25;

export interface ClassifyOptions {
  repoSlug: string;
  files: HfFile[];
  /** "awq" | "gptq" when config.json carries an explicit quantization_config. */
  explicitQuantMethod?: "awq" | "gptq" | null;
}

export interface ClassifyResult {
  weightsFormat: WeightsFormat;
  runtime: ModelRuntime;
  variants: ModelVariant[];
  companions: { role: GgufRole; file: string; sizeBytes: number }[];
  /** Derived base model name; exposed for tests and diagnostics. */
  baseName: string;
}

interface GgufCandidate {
  path: string;
  sizeBytes: number;
  stem: string;
  shard: ShardInfo | null;
  role: GgufRole;
  quantTag: string | null;
  family: string | null;
}

export function classifyRepoFiles(opts: ClassifyOptions): ClassifyResult {
  const { repoSlug, files } = opts;

  // 1. exclude non-weight artifacts BEFORE anything is parsed (FR-DEP-041c).
  const weightFiles = files.filter((f) => !isNonWeightArtifact(f.path));

  const ggufFiles = weightFiles.filter((f) => extensionOf(f.path) === ".gguf");
  const safetensorFiles = weightFiles.filter((f) => extensionOf(f.path) === ".safetensors");

  if (ggufFiles.length > 0) {
    return classifyGguf(repoSlug, ggufFiles);
  }
  if (safetensorFiles.length > 0) {
    return classifySafetensors(safetensorFiles, opts.explicitQuantMethod ?? null);
  }
  return {
    weightsFormat: "unknown",
    runtime: deriveRuntime("unknown"),
    variants: [],
    companions: [],
    baseName: "",
  };
}

function classifyGguf(repoSlug: string, ggufFiles: HfFile[]): ClassifyResult {
  const stems = ggufFiles.map((f) => stemOf(f.path));
  const baseName = deriveBaseName(repoSlug, stems);

  const candidates: GgufCandidate[] = ggufFiles.map((f) => {
    const rawStem = stemOf(f.path);
    const { stem, shard } = splitShardSuffix(rawStem);
    // 2. ROLE first — before the quant tag is even looked at.
    const role = classifyRole(stem);
    // 3. quant tag
    const quant = matchQuantTag(stem);
    // 4. family
    const family = deriveFamily(stem, baseName, quant);
    return {
      path: f.path,
      sizeBytes: f.sizeBytes,
      stem,
      shard,
      role,
      quantTag: quant ? quant.tag : null,
      family,
    };
  });

  // 6a. Companions never become variants (FR-DEP-041a / FR-DEP-046).
  const companions = candidates
    .filter((c) => c.role !== "model")
    .map((c) => ({ role: c.role, file: c.path, sizeBytes: c.sizeBytes }));

  // 5. group split shards into ONE variant (FR-DEP-042).
  const groups = new Map<string, GgufCandidate[]>();
  for (const c of candidates) {
    if (c.role !== "model") continue;
    // The shard suffix is already stripped, so every shard of one split model
    // shares a stem — and two distinct whole files can never share one.
    const key = c.stem.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const variants: ModelVariant[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const head = members[0];
    const weightsBytes = members.reduce((n, m) => n + m.sizeBytes, 0);
    const { bitsPerWeight, qualityLabel } = qualityForTag(head.quantTag);
    const variant: ModelVariant = {
      id: `${head.family ?? "base"}:${head.quantTag ?? "native"}`,
      quantTag: head.quantTag,
      family: head.family,
      role: head.quantTag === null ? "unknown" : "model",
      files: members.map((m) => m.path),
      weightsBytes,
      // Dense: bytes read per token == all weights. MoE is corrected later,
      // once the architecture read reports expert counts.
      activeWeightsBytes: weightsBytes,
      bitsPerWeight,
      qualityLabel,
      deployable: head.quantTag !== null,
    };
    if (head.quantTag === null) {
      // FR-DEP-041: surfaced as an "unknown" variant, never auto-selected.
      variant.excludedReason =
        "unrecognized quantization tag; requires explicit creator confirmation";
    }
    variants.push(variant);
  }

  // 6b. Size backstop. Compared against the largest GGUF *variant* (shards
  // summed) — comparing against a single shard would misfire on split repos.
  const largest = Math.max(
    0,
    ...variants.map((v) => v.weightsBytes),
    ...companions.map((c) => c.sizeBytes),
  );
  if (largest > 0) {
    const floor = largest * COMPANION_SIZE_FRACTION;
    for (const v of variants) {
      if (v.weightsBytes < floor) {
        v.deployable = false;
        v.role = "unknown";
        v.excludedReason =
          `suspected companion asset: ${formatGb(v.weightsBytes)} is under ` +
          `${Math.round(COMPANION_SIZE_FRACTION * 100)}% of the largest GGUF ` +
          `(${formatGb(largest)}); requires explicit creator confirmation`;
      }
    }
  }

  sortVariants(variants);
  return {
    weightsFormat: "gguf",
    runtime: deriveRuntime("gguf"),
    variants,
    companions,
    baseName,
  };
}

function classifySafetensors(
  files: HfFile[],
  quantMethod: "awq" | "gptq" | null,
): ClassifyResult {
  // safetensors: ONE variant — the repo's native precision (FR-DEP-040).
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const weightsBytes = sorted.reduce((n, f) => n + f.sizeBytes, 0);
  const format: WeightsFormat = quantMethod ?? "safetensors";
  const tag = quantMethod ? quantMethod.toUpperCase() : null;
  const quality = tag
    ? qualityForTag(tag)
    : { bitsPerWeight: 16, qualityLabel: "Full precision" };
  return {
    weightsFormat: format,
    runtime: deriveRuntime(format),
    variants: [
      {
        id: `base:${tag ?? "native"}`,
        quantTag: tag,
        family: null,
        role: "model",
        files: sorted.map((f) => f.path),
        weightsBytes,
        activeWeightsBytes: weightsBytes,
        bitsPerWeight: quality.bitsPerWeight,
        qualityLabel: quality.qualityLabel,
        deployable: true,
      },
    ],
    companions: [],
    baseName: "",
  };
}

function stemOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Base family first, then ascending quality within a family. */
function sortVariants(variants: ModelVariant[]): void {
  variants.sort((a, b) => {
    if (a.family !== b.family) {
      if (a.family === null) return -1;
      if (b.family === null) return 1;
      return a.family < b.family ? -1 : 1;
    }
    const ab = a.bitsPerWeight ?? Number.POSITIVE_INFINITY;
    const bb = b.bitsPerWeight ?? Number.POSITIVE_INFINITY;
    if (ab !== bb) return ab - bb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
