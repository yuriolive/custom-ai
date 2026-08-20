/**
 * probeRepo — the single entry point the deployment form calls.
 * FR-DEP-040 … FR-DEP-047, FR-DEP-060.
 *
 * Web APIs only on this path (fetch, DataView, TextDecoder): the same source
 * runs in a Supabase Edge Function (Deno) and in Node tooling.
 */

import type {
  DeclaredBaseModel,
  HfFile,
  HfProbeResult,
  ModelArchitecture,
} from "../../shared/types.ts";
import { classifyRepoFiles, deriveRuntime } from "./classify.ts";
import {
  architectureFromConfig,
  quantMethodFromConfig,
  type HfConfigJson,
} from "./config.ts";
import {
  getJson,
  getModelInfo,
  HF_ENDPOINT,
  listRepoFiles,
  resolveUrl,
  type HfCardData,
  type HfClientOptions,
} from "./hf.ts";
import { baseModelsFromHeader, readGgufArchitecture, type GgufHeader } from "./gguf.ts";
import { normalizeRelation, repoSlugFromRef } from "./identity.ts";
import { licenseFromCardData } from "./license.ts";

export interface ProbeOptions extends HfClientOptions {
  /** Git revision. Default "main". */
  revision?: string;
  /** Skip every network read of model architecture (offline unit tests). */
  skipArchitecture?: boolean;
  /** Byte ceiling for the GGUF header range read. */
  maxHeaderBytes?: number;
  /** First range size for the GGUF header read. */
  initialHeaderBytes?: number;
  /**
   * File list override — classify these instead of calling /tree/main.
   * This is how the committed fixture is replayed offline (FR-DEP-047).
   */
  files?: HfFile[];
}

function emptyResult(slug: string, revision: string): HfProbeResult {
  return {
    repoSlug: slug,
    revision,
    exists: false,
    isPrivate: false,
    isGated: false,
    libraryName: null,
    weightsFormat: "unknown",
    runtime: deriveRuntime("unknown"),
    variants: [],
    companions: [],
    architecture: null,
    declaredBaseModels: [],
    license: null,
  };
}

export async function probeRepo(slug: string, opts: ProbeOptions = {}): Promise<HfProbeResult> {
  const revision = opts.revision ?? "main";
  const endpoint = opts.endpoint ?? HF_ENDPOINT;
  const result = emptyResult(slug, revision);

  if (!slug.includes("/")) {
    result.architectureError = `invalid repo slug ${JSON.stringify(slug)}: expected "owner/name"`;
    return result;
  }

  // ── existence / private / gated ───────────────────────────────────────────
  const info = await getModelInfo(slug, opts);
  if (info.status === 404) {
    // A private repo probed without a token is indistinguishable from a
    // missing one — the Hub deliberately returns 404 for both.
    result.exists = false;
    result.architectureError = "repository not found (or private and no token was supplied)";
    return result;
  }
  if (info.status === 401) {
    result.exists = true;
    result.isPrivate = true;
    result.architectureError = "repository requires authentication";
    return result;
  }
  if (info.status === 403) {
    result.exists = true;
    result.isGated = true;
    result.architectureError = "repository is gated; access has not been granted to this token";
    return result;
  }
  if (info.status !== 200 || info.body === null) {
    result.architectureError = `Hugging Face model API error: ${info.error ?? info.status}`;
    return result;
  }

  const body = info.body;
  result.exists = true;
  result.isPrivate = body.private === true;
  result.isGated = body.gated !== undefined && body.gated !== false && body.gated !== null;
  result.libraryName = typeof body.library_name === "string" ? body.library_name : null;

  // ── declared identity + licence, from the SAME response (§2 signal 1) ─────
  // `cardData` is why getModelInfo asks for `?full=true`. Both facts are about
  // the WEIGHTS rather than this repo's packaging, and both are advisory here:
  // nothing below fails a probe because a card said nothing.
  const cardData = body.cardData ?? null;
  result.license = licenseFromCardData(cardData, { repoSlug: slug, revision, endpoint });
  result.declaredBaseModels = declaredFromCardData(cardData);

  // ── file list ─────────────────────────────────────────────────────────────
  let files: HfFile[];
  if (opts.files) {
    files = opts.files;
  } else {
    const tree = await listRepoFiles(slug, revision, opts);
    if (tree.body === null) {
      result.architectureError = `could not list repo files: ${tree.error ?? tree.status}`;
      return result;
    }
    files = tree.body;
  }

  // ── config.json (path 1, and AWQ/GPTQ detection) ──────────────────────────
  const hasConfig = files.some((f) => f.path === "config.json");
  let config: HfConfigJson | null = null;
  if (hasConfig && !opts.skipArchitecture) {
    const res = await getJson<HfConfigJson>(
      resolveUrl(slug, revision, "config.json", endpoint),
      opts,
    );
    config = res.body;
  }

  // ── variants ──────────────────────────────────────────────────────────────
  const classified = classifyRepoFiles({
    repoSlug: slug,
    files,
    explicitQuantMethod: config ? quantMethodFromConfig(config) : null,
  });
  result.weightsFormat = classified.weightsFormat;
  result.runtime = classified.runtime;
  result.variants = classified.variants;
  result.companions = classified.companions;

  if (classified.variants.every((v) => !v.deployable)) {
    // FR-DEP-045 — surfaced, not thrown; the form renders the reason.
    result.architectureError =
      classified.variants.length === 0
        ? "repository contains no deployable weights (no .gguf or .safetensors files)"
        : "repository contains no deployable variant; every candidate was excluded";
  }

  if (opts.skipArchitecture) return result;

  // ── architecture (FR-DEP-043) ─────────────────────────────────────────────
  const arch = await resolveArchitecture(slug, revision, endpoint, config, classified, opts);
  if (arch.ok) {
    result.architecture = arch.architecture;
    // Signal 2, free of charge: the header was already fetched and parsed for
    // the geometry above, and for a llama.cpp-native repo — which frequently
    // ships no model card at all — it is the only declaration that exists.
    if (arch.header) {
      result.declaredBaseModels = [
        ...result.declaredBaseModels,
        ...declaredFromGgufHeader(arch.header),
      ];
    }
    // A FR-DEP-045 "no deployable variant" reason set above is deliberately
    // kept: the repo is still not deployable even though we read its geometry.
  } else {
    result.architecture = null;
    result.architectureError = arch.error;
  }
  return result;
}

/**
 * `cardData.base_model` is a string on most repos and an ARRAY on merges, which
 * name every ingredient. The relation applies to all of them, and the first
 * entry is the one a merge is conventionally attributed to.
 */
function declaredFromCardData(cardData: HfCardData | null): DeclaredBaseModel[] {
  if (!cardData) return [];
  const raw = cardData.base_model;
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const relation = normalizeRelation(cardData.base_model_relation);

  const out: DeclaredBaseModel[] = [];
  for (const entry of entries) {
    const repoSlug = repoSlugFromRef(entry);
    if (repoSlug === null) continue;
    out.push({ repoSlug, relation, source: "card_data" });
  }
  return out;
}

function declaredFromGgufHeader(header: GgufHeader): DeclaredBaseModel[] {
  const out: DeclaredBaseModel[] = [];
  for (const ref of baseModelsFromHeader(header)) {
    const repoSlug =
      repoSlugFromRef(ref.repoUrl) ??
        (ref.organization && ref.name ? repoSlugFromRef(`${ref.organization}/${ref.name}`) : null);
    if (repoSlug === null) continue;
    // The header has no relation key at all — the cascade infers it from the
    // name, and infers "derived" whenever it cannot tell.
    out.push({ repoSlug, relation: null, source: "gguf_header" });
  }
  return out;
}

async function resolveArchitecture(
  slug: string,
  revision: string,
  endpoint: string,
  config: HfConfigJson | null,
  classified: { variants: HfProbeResult["variants"]; weightsFormat: string },
  opts: ProbeOptions,
): Promise<
  { ok: true; architecture: ModelArchitecture; header?: GgufHeader } | { ok: false; error: string }
> {
  // 1. config.json
  if (config) {
    const fromConfig = architectureFromConfig(config);
    if (fromConfig.ok) return fromConfig;
    if (classified.weightsFormat !== "gguf") return fromConfig;
    // GGUF repo with an unusable config.json: fall through to the header.
  }

  // 2. GGUF key-value header — the ONLY path for a llama.cpp-native repo.
  if (classified.weightsFormat === "gguf") {
    // Families are DIFFERENT MODELS (FR-DEP-041b) and their geometry differs:
    // on the MVP target repo the base family reports block_count 65 while the
    // noMTP family reports 64. Read the base family, and only fall back to
    // another family when there is no base one. HfProbeResult carries a single
    // architecture, so this picks the family the form defaults to.
    const deployableVariants = classified.variants.filter(
      (v) => v.deployable && v.files.length > 0,
    );
    const preferred = deployableVariants.filter((v) => v.family === null);
    const candidates = (preferred.length > 0 ? preferred : deployableVariants).toSorted(
      (a, b) => a.weightsBytes - b.weightsBytes,
    );
    const target = candidates[0] ?? classified.variants.find((v) => v.files.length > 0);
    if (!target) {
      return { ok: false, error: "no GGUF file available to read an architecture header from" };
    }
    const url = resolveUrl(slug, revision, target.files[0], endpoint);
    const read = await readGgufArchitecture(url, {
      fetchImpl: opts.fetchImpl,
      hfToken: opts.hfToken,
      signal: opts.signal,
      maxBytes: opts.maxHeaderBytes,
      initialBytes: opts.initialHeaderBytes,
    });
    if (read.ok) return { ok: true, architecture: read.architecture, header: read.header };
    return { ok: false, error: `${read.error} (${target.files[0]})` };
  }

  // 3. Neither -> REJECT. Never guess a memory profile.
  return {
    ok: false,
    error: "no config.json and no GGUF header available; refusing to guess a memory profile",
  };
}
