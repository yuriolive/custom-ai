/**
 * Licence capture and the one question a marketplace actually has to answer:
 * MAY A THIRD PARTY SERVE THESE WEIGHTS FOR MONEY.
 *
 * That is not a function of the SPDX id alone, which is why
 * `public.commercial_hosting` has four states and not two: Llama's community
 * licence permits commercial hosting with obligations a human must read,
 * CC-BY-NC forbids it outright, and `other` says nothing at all. `unknown` is
 * the honest answer for everything unrecognised, and `unknown` never
 * auto-publishes (that gate is #29, not this module).
 *
 * PURE, like identity.ts, and for the same reason: this decides whether weights
 * can be sold, so it has to be readable and testable without a network.
 */

import type { CommercialHosting, RepoLicense } from "../../shared/types.ts";
import type { HfCardData } from "./hf.ts";

/**
 * Non-commercial and no-derivatives markers, checked BEFORE the table.
 *
 * Order matters here and nowhere else in this file: a licence id nobody
 * catalogued must not be able to fall through to a permissive default, and a
 * typo in the table below must not be able to relicense `cc-by-nc-4.0`.
 * `-nd-` is prohibited alongside `-nc-` because a quantization IS a derivative.
 */
const PROHIBITED_PATTERNS: RegExp[] = [
  /(^|[-_.])nc([-_.]|$)/,
  /(^|[-_.])nd([-_.]|$)/,
  /non-?commercial/,
  /research(-only)?(-|$)|(^|-)research$/,
  /no-?deriv/,
  /evaluation-only/,
];

/** Permissive: attribution-free, or attribution so nominal it blocks nothing. */
const ALLOWED = new Set([
  "apache-2.0",
  "mit",
  "bsd",
  "bsd-2-clause",
  "bsd-3-clause",
  "bsd-3-clause-clear",
  "cc0-1.0",
  "unlicense",
  "wtfpl",
  "isc",
  "zlib",
  "ncsa",
  "postgresql",
  "mpl-2.0",
  "artistic-2.0",
  "bsl-1.0",
  "cdla-permissive-1.0",
  "cdla-permissive-2.0",
  "pddl",
]);

/**
 * Commercial hosting is permitted, with obligations somebody has to read:
 * attribution, share-alike, an acceptable-use annex, or a user-count clause.
 * Collapsing these into `allowed` publishes a listing that needs a human;
 * collapsing them into `prohibited` blocks Llama, the most deployed weight
 * family on the Hub.
 */
const CONDITIONAL = new Set([
  "llama2",
  "llama3",
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "llama4",
  "gemma",
  "qwen",
  "tongyi-qianwen",
  "yi-license",
  "falcon-180b-license",
  "apple-ascl",
  "openrail",
  "openrail++",
  "bigscience-openrail-m",
  "bigcode-openrail-m",
  "creativeml-openrail-m",
  "bigscience-bloom-rail-1.0",
  "c-uda",
  "odc-by",
  "odbl",
  "cdla-sharing-1.0",
  "cc-by-2.0",
  "cc-by-2.5",
  "cc-by-3.0",
  "cc-by-4.0",
  "cc-by-sa-3.0",
  "cc-by-sa-4.0",
  "gpl",
  "gpl-2.0",
  "gpl-3.0",
  "lgpl",
  "lgpl-2.1",
  "lgpl-3.0",
  "agpl-3.0",
  "epl-1.0",
  "epl-2.0",
  "eupl-1.1",
  "osl-3.0",
  "ecl-2.0",
  "afl-3.0",
  "ms-pl",
  "etalab-2.0",
]);

/** Named, catalogued, and non-commercial regardless of what the id looks like. */
const PROHIBITED = new Set([
  "deepfloyd-if-license",
  "apple-amlr",
  "intel-research",
  "cc-by-nd-4.0",
]);

/** Lowercased, trimmed, and `other`/`unknown` collapsed to null. */
export function normalizeLicenseId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v === "other" || v === "unknown" || v === "unlicensed") return null;
  return v.slice(0, 100);
}

/**
 * The enum value for a licence id. `unknown` for anything unrecognised, an
 * absent licence, or the Hub's `other` — which is not a licence, it is the
 * absence of a catalogued one.
 */
export function commercialHostingFor(licenseId: string | null | undefined): CommercialHosting {
  const id = normalizeLicenseId(licenseId);
  if (id === null) return "unknown";
  if (PROHIBITED.has(id)) return "prohibited";
  if (PROHIBITED_PATTERNS.some((re) => re.test(id))) return "prohibited";
  if (ALLOWED.has(id)) return "allowed";
  if (CONDITIONAL.has(id)) return "conditional";
  return "unknown";
}

/** First entry of `license:`, which is a string on most cards and a list on some. */
function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string" && entry.trim()) return entry;
  }
  return null;
}

/**
 * `license_link` is frequently a repo-relative path — literally `LICENSE` — so
 * it is absolutized against the repo it came from. A link that resolves to
 * nothing is worse than no link: it is the one a creator clicks to read the
 * terms they are being asked to accept.
 */
function absolutizeLink(
  link: string | null,
  repo: { repoSlug?: string; revision?: string; endpoint?: string } | undefined,
): string | null {
  if (!link) return null;
  const trimmed = link.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, 2000);
  if (!repo?.repoSlug) return null;
  const endpoint = repo.endpoint ?? "https://huggingface.co";
  const revision = encodeURIComponent(repo.revision ?? "main");
  const path = trimmed.replace(/^\.?\//, "");
  return `${endpoint}/${repo.repoSlug}/blob/${revision}/${path}`.slice(0, 2000);
}

/**
 * The licence a model card declares.
 *
 * `license: other` with `license_name: qwen-research` is a real and common
 * shape, and the id alone reads as "unknown" there while the NAME says
 * non-commercial in plain sight — so the name is classified too, and the
 * STRICTER of the two answers wins.
 */
export function licenseFromCardData(
  cardData: HfCardData | null | undefined,
  repo?: { repoSlug?: string; revision?: string; endpoint?: string },
): RepoLicense | null {
  if (!cardData) return null;
  const id = normalizeLicenseId(firstString(cardData.license));
  const rawName = typeof cardData.license_name === "string" ? cardData.license_name.trim() : "";
  const name = rawName.length > 0 ? rawName.slice(0, 200) : null;
  const url = absolutizeLink(
    typeof cardData.license_link === "string" ? cardData.license_link : null,
    repo,
  );
  if (id === null && name === null && url === null) return null;

  return {
    id,
    name,
    url,
    commercialHosting: strictest(commercialHostingFor(id), commercialHostingFor(name)),
  };
}

/** allowed < conditional < prohibited. `unknown` is not a rank — see below. */
const RANK: Record<CommercialHosting, number> = {
  allowed: 0,
  conditional: 1,
  unknown: 2,
  prohibited: 3,
};

/**
 * The stricter of two readings of the same licence.
 *
 * `unknown` DEFERS rather than winning, which is the one non-obvious rule here:
 * it is not a strictness level, it is the absence of an answer, and letting an
 * unrecognised `license_name` overwrite a recognised `license` id would report
 * Apache-2.0 weights as unclassified. Two unknowns still yield `unknown`, which
 * is what blocks the publish gate.
 */
export function strictest(a: CommercialHosting, b: CommercialHosting): CommercialHosting {
  if (a === "unknown") return b === "unknown" ? "unknown" : b;
  if (b === "unknown") return a;
  return RANK[a] >= RANK[b] ? a : b;
}
