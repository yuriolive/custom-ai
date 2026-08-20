/**
 * Console-specific display formatting. Money helpers live in `lib/format.ts`
 * and are re-exported here so a console component has one import for all of it.
 *
 * Dates are formatted with an explicit, fixed locale and time zone. A bare
 * `toLocaleString()` renders differently on the server than in the browser and
 * produces a hydration mismatch on every timestamp in every table.
 */

export {
  formatBalanceMicroUsd,
  formatMicroUsd,
  formatMs,
  formatRate,
  formatTokens,
} from "@/lib/format";

import { formatMicroUsd } from "@/lib/format";

const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** `Aug 17, 2026` — UTC, stable across server and client. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE.format(d);
}

/** `Aug 17, 2026, 14:03:21` — UTC. Used wherever a ledger needs precision. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_TIME.format(d);
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/**
 * `3 hours ago`. Takes `now` explicitly so a server render and the hydrating
 * client render agree — passing `Date.now()` implicitly is the usual cause of
 * "text content did not match" on relative timestamps.
 */
export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";

  let delta = Math.round((then - now) / 1000);
  for (const [unit, span] of RELATIVE_STEPS) {
    if (Math.abs(delta) < span) return RELATIVE.format(delta, unit);
    delta = Math.trunc(delta / span);
  }
  return RELATIVE.format(delta, "year");
}

/**
 * Signed money for the ledger: `+$5.00` / `-$0.000412`. The sign is carried by
 * the integer, so this only decides where to put the glyph.
 */
export function formatSignedMicroUsd(micro: number): string {
  const body = formatMicroUsd(Math.abs(micro));
  if (micro > 0) return `+${body}`;
  if (micro < 0) return `-${body}`;
  return body;
}

const LEDGER_LABELS: Record<string, string> = {
  topup: "Top-up",
  grant: "Grant",
  usage_debit: "Usage",
  refund: "Refund",
  chargeback: "Chargeback",
  adjustment: "Adjustment",
};

export function ledgerKindLabel(kind: string): string {
  return LEDGER_LABELS[kind] ?? kind;
}

/** ISO instant for `n` days before `now`, used for the trailing-window queries. */
export function daysAgoIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/** `YYYY-MM-DD` in UTC — the value shape of an `<input type="date">`. */
export function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

/** Start-of-day UTC instant for a `YYYY-MM-DD` input value. */
export function dateInputToIsoStart(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** End-of-day UTC instant for a `YYYY-MM-DD` input value (inclusive upper bound). */
export function dateInputToIsoEnd(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
