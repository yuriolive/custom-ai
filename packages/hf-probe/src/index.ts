/**
 * @nexus/hf-probe — Hugging Face repo probe, GGUF variant classifier and
 * GGUF key-value header reader.
 *
 * Deno and Node both import this file directly; there is no build step and no
 * Node-only builtin on the main path.
 */

export { probeRepo, type ProbeOptions } from "./probe.ts";

export {
  classifyRepoFiles,
  classifyRole,
  deriveBaseName,
  deriveFamily,
  deriveRuntime,
  isNonWeightArtifact,
  splitShardSuffix,
  COMPANION_SIZE_FRACTION,
  type ClassifyOptions,
  type ClassifyResult,
} from "./classify.ts";

export {
  matchQuantTag,
  qualityForTag,
  QUANT_TAG_PATTERN,
  UNKNOWN_QUALITY_LABEL,
  type QuantMatch,
  type QuantQuality,
} from "./quant.ts";

export {
  architectureFromHeader,
  deriveAttentionLayers,
  moeFromHeader,
  parseGgufHeader,
  readGgufArchitecture,
  readGgufChatTemplate,
  CHAT_TEMPLATE_KEY,
  DEFAULT_INITIAL_BYTES,
  DEFAULT_MAX_BYTES,
  DEFAULT_TEMPLATE_BYTES,
  DEFAULT_TEMPLATE_MAX_BYTES,
  type GgufArchitectureResult,
  type GgufChatTemplateResult,
  type GgufHeader,
  type GgufReadOptions,
  type GgufValue,
} from "./gguf.ts";

export {
  detectToolSupport,
  resolveToolSupport,
  CHAT_TEMPLATE_FILE,
  TOKENIZER_CONFIG_FILE,
  type ToolSupportOptions,
  type ToolSupportResult,
  type ToolSupportSource,
} from "./chat-template.ts";

export {
  architectureFromConfig,
  moeFromConfig,
  quantMethodFromConfig,
  type HfConfigJson,
} from "./config.ts";

export {
  getModelInfo,
  getText,
  listRepoFiles,
  resolveUrl,
  HF_ENDPOINT,
  type HfClientOptions,
  type HfModelInfo,
} from "./hf.ts";
