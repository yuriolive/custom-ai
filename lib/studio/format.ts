/**
 * Display formatting for Creator Studio.
 *
 * Money formatting is NOT here — `lib/format.ts` owns it, and this module
 * re-exports nothing so there is exactly one `formatMicroUsd` in the app.
 * What is here is the unit vocabulary the Studio adds: bytes, context windows,
 * throughput and price-per-million.
 *
 * Every one of these is a final presentation step. Nothing downstream parses
 * the string back into a number.
 */

const GIB = 1_073_741_824;
const MIB = 1_048_576;

/**
 * Binary gigabytes, one decimal. The solver reasons in GiB (its own reject
 * messages say "needs 18.2 GB, usable 23.7 GB"), so the UI must use the same
 * base or the two disagree on screen by 7%.
 */
export function formatGiB(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < MIB) return `${bytes} B`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(0)} MiB`;
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** Context windows read as `8k` / `128k` / `262k`, never as 262144. */
export function formatContext(tokens: number | null | undefined): string {
  if (tokens == null) return "—";
  if (tokens < 1000) return String(tokens);
  return `${Math.round(tokens / 1024)}k`;
}

/** Exact token count with separators, for the places `8k` is too vague. */
export function formatExactTokens(tokens: number | null | undefined): string {
  if (tokens == null) return "—";
  return tokens.toLocaleString("en-US");
}

/** Whole tokens per second. The solver rounds; do not add false precision. */
export function formatTokensPerSecond(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value)} tok/s`;
}

/**
 * A price per 1M tokens, from micro-USD.
 *
 * Kept separate from `formatMicroUsd` because the useful precision differs: a
 * per-1M price is a headline figure in dollars-and-cents, while a settled
 * charge can be a fraction of a cent and needs six decimals to be non-zero.
 * Two decimals below $100, three below $10 — so a $1.294 cost floor does not
 * collapse to $1.29 next to a price the creator typed as 1.29.
 */
export function formatPricePerMtoken(micro: number | null | undefined): string {
  if (micro == null) return "—";
  const abs = Math.abs(Math.trunc(micro));
  const decimals = abs < 10_000_000 ? 3 : 2;
  const divisor = 10 ** (6 - decimals);
  const scaled = Math.round(abs / divisor);
  const whole = Math.floor(scaled / 10 ** decimals);
  const frac = String(scaled % 10 ** decimals).padStart(decimals, "0");
  return `${micro < 0 ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/**
 * `formatOptions` for every price NumberField in the Studio.
 *
 * NOT OPTIONAL, and the reason is a real 100x mispricing observed in this app.
 *
 * A bare `NumberField` parses with the BROWSER's locale. On a pt-BR browser —
 * the one this was found on — `.` is a GROUP separator, so typing `3.25` into
 * an unconfigured field yields **325**, and `$3.25 per 1M tokens` is stored as
 * `$325.00 per 1M tokens`. Nothing errors: 325000000 is a perfectly valid
 * BIGINT and well inside the column's CHECK. The creator finds out when
 * somebody is billed a hundred times over.
 *
 * Declaring the field as USD currency makes the intent explicit to React Aria,
 * which then formats the committed value back into the field on blur — so the
 * number the platform understood is the number on screen. That is the visible
 * half of the fix; `microUsdEcho` below is the other half.
 */
export const PRICE_FORMAT_OPTIONS = {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
} as const satisfies Intl.NumberFormatOptions;

/**
 * Dollars typed into a NumberField -> integer micro-USD.
 *
 * `Math.round` on the scaled value, not on the input: `1.23 * 1e6` is
 * 1229999.9999999998 in IEEE-754, and truncating that yields 1229999 — a
 * one-micro-dollar understatement on every price ending in 3. The float exists
 * for exactly this one line (a NumberField hands back a JS number and there is
 * no way for it not to) and does not survive it.
 */
export function dollarsPerMtokenToMicro(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars < 0) return 0;
  return Math.round(dollars * 1_000_000);
}

/**
 * The exact integer that will be stored, spelled out for the creator.
 *
 * Where a check is cheap, make the failure loud. A locale that parses `3.25` as
 * `325` cannot be prevented from the outside, but it CAN be made impossible to
 * miss: this renders `3,250,000` under a correct entry and `325,000,000` under
 * a misparsed one, next to the field, before anything is saved.
 */
export function microUsdEcho(micro: number): string {
  return `${micro.toLocaleString("en-US")} micro-USD per 1M tokens`;
}

/** The inverse, for pre-filling a NumberField from a stored integer. */
export function microToDollarsPerMtoken(micro: number): number {
  return micro / 1_000_000;
}

/** Cold-start budget in seconds, as `1m 41s`. */
export function formatSeconds(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * The honest quality note per quant tag (PRD §4.3.3.2 quality ladder).
 *
 * `qualityLabel` and `bitsPerWeight` come from `@nexus/hf-probe`; the ladder's
 * prose column does not, so it lives here as presentation copy. Adding a tag
 * to the classifier without adding it here degrades to no note, never to a
 * wrong one.
 */
const QUALITY_NOTES: Record<string, string> = {
  IQ2_M: "Importance-matrix 2-bit. Better than Q2_K per bit, still heavily degraded.",
  Q2_K: "Severe degradation. Offered, never recommended.",
  Q3_K_M: "Noticeable quality loss on reasoning tasks.",
  IQ4_XS: "Importance-matrix 4-bit. Smaller than Q4_K_M at similar quality.",
  Q4_K_M: "Community default. Best quality per byte.",
  Q5_K_M: "Near-lossless for most tasks.",
  Q6_K: "Effectively indistinguishable from FP16.",
  Q8_0: "Lossless in practice.",
  F16: "Reference weights. Twice the cost of Q8 for no measurable gain.",
  BF16: "Reference weights. Twice the cost of Q8 for no measurable gain.",
  AWQ: "4-bit, vLLM-native. Faster than GGUF on datacenter GPUs.",
  GPTQ: "4-bit, vLLM-native. Faster than GGUF on datacenter GPUs.",
};

export function qualityNote(quantTag: string | null): string | null {
  if (!quantTag) return null;
  return QUALITY_NOTES[quantTag.toUpperCase()] ?? null;
}
