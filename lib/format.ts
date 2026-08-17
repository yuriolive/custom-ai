/**
 * Display formatting for micro-USD. Integer maths only, per CONTRACTS.md
 * §Money: "No floats anywhere in a monetary path". The division below is the
 * single, final presentation step — nothing downstream reads the result back.
 */
export function formatMicroUsd(micro: number | null | undefined): string {
  if (micro == null) return "—";
  const negative = micro < 0;
  const abs = Math.abs(Math.trunc(micro));

  // Below a tenth of a cent, show 4 decimals so a real charge never reads $0.00.
  const decimals = abs < 1_000 ? 6 : abs < 10_000 ? 4 : 2;
  const divisor = 10 ** (6 - decimals);
  const scaled = Math.round(abs / divisor);
  const whole = Math.floor(scaled / 10 ** decimals);
  const frac = String(scaled % 10 ** decimals).padStart(decimals, "0");

  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/** Compact integer formatting for token counts. */
export function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US");
}

/** Milliseconds, rendered as ms under a second and seconds above it. */
export function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(Math.round(value / 100) / 10).toFixed(1)} s`;
}

/** Tokens per second, one decimal. */
export function formatRate(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(Math.round(value * 10) / 10).toFixed(1)} tok/s`;
}
