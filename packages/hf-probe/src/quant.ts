/**
 * Quantization tag parsing and the creator-facing quality ladder.
 * FR-DEP-041 (tag regex) and §4.3.3.2's quality table.
 *
 * Runtime-free: no imports, no platform APIs. Runs identically on Deno and Node.
 */

/**
 * FR-DEP-041, verbatim. Case-insensitive.
 * Alternation order is load-bearing: `Q\d+_K_[SML]` must be tried before
 * `Q\d+_K` or "Q4_K_M" degrades to "Q4_K".
 */
export const QUANT_TAG_PATTERN =
  "(IQ\\d+_[A-Z]+|Q\\d+_K_[SML]|Q\\d+_K|Q\\d+_\\d+|F16|BF16|F32)";

const QUANT_TAG_RE = new RegExp(QUANT_TAG_PATTERN, "gi");

/** Separators that may delimit a quant tag inside a filename stem. */
const SEP = /[-_. ]/;

export interface QuantMatch {
  /** Normalized (upper-cased) tag, e.g. "Q4_K_M". */
  tag: string;
  start: number;
  end: number;
}

/**
 * Find the quant tag in a filename stem. Returns the LAST boundary-delimited
 * match — quantizers put the tag at the end, and a base model name may
 * accidentally contain something tag-shaped.
 */
export function matchQuantTag(stem: string): QuantMatch | null {
  QUANT_TAG_RE.lastIndex = 0;
  let best: QuantMatch | null = null;
  for (let m = QUANT_TAG_RE.exec(stem); m !== null; m = QUANT_TAG_RE.exec(stem)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start === 0 ? "" : stem[start - 1];
    const after = end === stem.length ? "" : stem[end];
    const okBefore = before === "" || SEP.test(before);
    const okAfter = after === "" || SEP.test(after);
    if (okBefore && okAfter) best = { tag: m[0].toUpperCase(), start, end };
  }
  return best;
}

export interface QuantQuality {
  /** Approximate bits per weight. null when the tag is not in the ladder. */
  bitsPerWeight: number | null;
  /** Creator-facing label. Never the raw tag. */
  qualityLabel: string;
}

/**
 * The quality ladder. Rows marked (PRD) are quoted verbatim from §4.3.3.2;
 * the remaining rows are the standard llama.cpp ladder, filled in so that a
 * repo shipping Q3_K_S does not fall off the table. Labels for non-PRD rows
 * come from `labelForBpw` so the ladder stays monotone.
 */
const LADDER: Record<string, number> = {
  // sub-3-bit importance-matrix
  IQ1_S: 1.6,
  IQ1_M: 1.8,
  IQ2_XXS: 2.1,
  IQ2_XS: 2.3,
  IQ2_S: 2.5,
  IQ2_M: 2.7, // PRD
  Q2_K: 2.6, // PRD
  Q2_K_S: 2.4,
  // 3-bit
  IQ3_XXS: 3.1,
  IQ3_XS: 3.3,
  IQ3_S: 3.4,
  IQ3_M: 3.7,
  Q3_K_S: 3.5,
  Q3_K_M: 3.9, // PRD
  Q3_K_L: 4.3,
  Q3_K: 3.9,
  // 4-bit
  IQ4_XS: 4.25, // PRD
  IQ4_NL: 4.5,
  Q4_0: 4.5,
  Q4_1: 5.0,
  Q4_K_S: 4.6,
  Q4_K_M: 4.8, // PRD
  Q4_K: 4.8,
  // 5-bit
  Q5_0: 5.5,
  Q5_1: 6.0,
  Q5_K_S: 5.5,
  Q5_K_M: 5.7, // PRD
  Q5_K: 5.7,
  // 6/8-bit
  Q6_K: 6.6, // PRD
  Q8_0: 8.5, // PRD
  // full precision
  F16: 16, // PRD
  BF16: 16, // PRD
  F32: 32,
  // GPU-native (safetensors repos with an explicit quant config)
  AWQ: 4.2, // PRD
  GPTQ: 4.2, // PRD
};

/** Labels the PRD fixes explicitly; everything else is bucketed by bpw. */
const EXPLICIT_LABELS: Record<string, string> = {
  IQ2_M: "Minimum",
  Q2_K: "Minimum",
  Q3_K_M: "Reduced",
  IQ4_XS: "Balanced (compact)",
  Q4_K_M: "Balanced",
  Q5_K_M: "High",
  Q6_K: "Very high",
  Q8_0: "Maximum",
  F16: "Full precision",
  BF16: "Full precision",
  F32: "Full precision",
  AWQ: "Balanced (GPU-native)",
  GPTQ: "Balanced (GPU-native)",
};

export function labelForBpw(bpw: number): string {
  if (bpw < 3) return "Minimum";
  if (bpw < 4.2) return "Reduced";
  if (bpw < 5.2) return "Balanced";
  if (bpw < 6.2) return "High";
  if (bpw < 7.5) return "Very high";
  if (bpw < 12) return "Maximum";
  return "Full precision";
}

/** Label used when we could not parse a tag at all. Never auto-selected. */
export const UNKNOWN_QUALITY_LABEL = "Unknown quantization";

export function qualityForTag(tag: string | null): QuantQuality {
  if (tag === null) return { bitsPerWeight: null, qualityLabel: UNKNOWN_QUALITY_LABEL };
  const key = tag.toUpperCase();
  const bpw = LADDER[key];
  if (bpw === undefined) return { bitsPerWeight: null, qualityLabel: UNKNOWN_QUALITY_LABEL };
  return { bitsPerWeight: bpw, qualityLabel: EXPLICIT_LABELS[key] ?? labelForBpw(bpw) };
}
