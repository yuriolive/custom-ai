/**
 * Reading a Hugging Face model card: its opening paragraph, and its LICENCE.
 *
 * PURE — no fetch, no `server-only`, so every rule below is unit-tested
 * (`card.test.ts`). `server/model-card.ts` is the one-function wrapper that
 * fetches the card and hands it here.
 *
 * WHY THIS IS NOT IN `@nexus/hf-probe`: that package answers "what can be
 * deployed and what is its memory profile" — questions with exact answers that
 * its tests pin down. The paragraph extraction is a heuristic for a form field
 * the creator can overwrite, and a heuristic has no business inside the
 * classifier that decides whether a 3 GB file is a servable model.
 *
 * The description is advisory in every direction: a missing card, a private
 * repo, a network failure and an unparseable README all produce `null`, and the
 * form simply leaves the field empty.
 *
 * The frontmatter is a different matter and not a heuristic at all — it is the
 * source the Hub itself parses `cardData` from. This module used to skip it and
 * throw it away, correctly as prose, and that threw away the LICENCE with it.
 * The card is already being fetched for the paragraph, so keeping the licence
 * costs one parse and no request. `@nexus/hf-probe` reads the same facts out of
 * `GET /api/models/{id}?full=true` and is the PRIMARY source; this is the
 * fallback for a repo whose `cardData` the Hub does not return.
 */

import {
  licenseFromCardData,
  normalizeRelation,
  repoSlugFromRef,
  type DeclaredBaseModel,
  type HfCardData,
  type RepoLicense,
} from "@nexus/hf-probe";

const CARD_MAX_CHARS = 600;

/**
 * Hard cap on the text handed to `stripInline`.
 *
 * Its markdown patterns are super-linear: `\[([^\]]*)\]\([^)]*\)` and
 * `<[^>]*>` both rescan from every candidate start position, so a paragraph of
 * `[[[[[[[…` costs O(n^2). Rewriting them to be provably linear means writing a
 * markdown tokenizer, which is far more machinery than a form hint deserves.
 *
 * Bounding the input kills the concern arithmetically instead: the result is
 * truncated to CARD_MAX_CHARS anyway, so anything past this prefix could never
 * have been shown. At 4,000 characters the pathological case is ~16M character
 * comparisons — microseconds — and the README behind it is fetched from a
 * repository the creator names, which is exactly the input that must not be
 * able to occupy a route worker.
 */
const STRIP_INPUT_MAX_CHARS = 4_000;

/** Fenced blocks, badges, images, tables and HTML: never a description. */
function isProse(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.startsWith("#") || t.startsWith(">") || t.startsWith("|")) return false;
  if (t.startsWith("<") || t.startsWith("```") || t.startsWith("---")) return false;
  if (t.startsWith("![") || t.startsWith("[![")) return false;
  if (t.startsWith("-") || t.startsWith("*") || /^\d+\./.test(t)) return false;
  return true;
}

/** Inline markdown -> plain text. Links keep their label, not their URL. */
function stripInline(rawText: string): string {
  const text = rawText.slice(0, STRIP_INPUT_MAX_CHARS);
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First prose paragraph of a README, with the YAML frontmatter removed.
 *
 * The frontmatter matters: every model card starts with one, it holds
 * `base_model` and `license`, and treating it as prose would suggest
 * "license: apache-2.0" as the model's description.
 */
export function descriptionFromCard(markdown: string): string | null {
  let body = markdown;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4);
  }

  const lines = body.split("\n");
  const paragraph: string[] = [];
  for (const line of lines) {
    if (isProse(line)) {
      paragraph.push(line.trim());
    } else if (paragraph.length > 0) {
      break;
    }
  }

  const text = stripInline(paragraph.join(" "));
  if (text.length < 20) return null;
  if (text.length <= CARD_MAX_CHARS) return text;

  // Cut at a sentence boundary rather than mid-word, so the suggestion reads as
  // a finished thought the creator can accept as-is.
  const cut = text.slice(0, CARD_MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > 200 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

// ─── frontmatter ────────────────────────────────────────────────────────────

/** Keys worth reading. Everything else in a card's frontmatter is not ours. */
const FRONTMATTER_KEYS = new Set([
  "license",
  "license_name",
  "license_link",
  "base_model",
  "base_model_relation",
]);

/** `"value"` / `'value'` -> `value`, or null when the value is not quoted. */
function unquote(text: string): string | null {
  const m = /^(["'])(.*)\1$/.exec(text);
  return m ? m[2]!.trim() : null;
}

/** Trailing comments and the quoting styles cards are written in. */
function scalar(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("#")) return "";
  // Unquote BEFORE stripping a comment, and again after: a fully quoted value
  // may legitimately contain " #", and a quoted value may equally be followed
  // by a real comment. Trying both orders is two regexes; guessing is a wrong
  // licence id or a truncated repo path.
  const asQuoted = unquote(v);
  if (asQuoted !== null) return asQuoted;
  const hash = v.indexOf(" #");
  if (hash !== -1) v = v.slice(0, hash).trim();
  return unquote(v) ?? v;
}

/**
 * The card's YAML frontmatter, restricted to the keys above.
 *
 * A YAML PARSER IS NOT WANTED HERE. This reads five keys off the top level of a
 * document whose shape is fixed by the Hub's own card template, and the
 * alternative is a dependency that parses arbitrary YAML — anchors, merge keys,
 * tags — out of a file supplied by whoever owns the repository. Anything it
 * cannot read is simply absent, which is the same outcome as a missing card.
 */
export function frontmatterFromCard(markdown: string): HfCardData | null {
  if (!markdown.startsWith("---")) return null;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return null;

  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of markdown.slice(3, end).split("\n")) {
    listKey = readFrontmatterLine(line, out, listKey);
  }

  return Object.keys(out).length > 0 ? (out as HfCardData) : null;
}

/**
 * One frontmatter line, folded into `out`. Returns the list still being
 * collected, if any — a blank or unparseable line does not end a list, which is
 * what lets `base_model:` followed by an indented block of `- entries` work.
 */
function readFrontmatterLine(
  line: string,
  out: Record<string, string | string[]>,
  listKey: string | null,
): string | null {
  const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
  if (item && listKey) {
    const value = scalar(item[1]!);
    if (value) (out[listKey] as string[]).push(value);
    return listKey;
  }

  // Anchored with no leading whitespace on purpose: an indented key belongs to a
  // nested map (`model-index:`, `widget:`) and is not a card-level fact.
  const pair = /^([A-Za-z_]\w*)[ \t]*:[ \t]*(.*)$/.exec(line);
  if (!pair) return listKey;

  const key = pair[1]!;
  // A top-level key closes whatever list was being collected, whether or not
  // this is a key worth keeping.
  if (!FRONTMATTER_KEYS.has(key)) return null;

  const value = scalar(pair[2]!);
  if (value.length > 0) {
    out[key] = value;
    return null;
  }
  // `key:` with nothing after it opens a list.
  out[key] = [];
  return key;
}

/** `base_model:` is a scalar on most cards and a list on a merge. Both, as a list. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

/** Everything one fetch of the card yields. Every field is independently null. */
export interface CardFacts {
  description: string | null;
  license: RepoLicense | null;
  /** Signal 1, read from the card itself rather than from the Hub's copy of it. */
  declaredBaseModels: DeclaredBaseModel[];
}

export function factsFromCard(
  markdown: string,
  repo: { repoSlug: string; revision: string },
): CardFacts {
  const frontmatter = frontmatterFromCard(markdown);
  const entries = asList(frontmatter?.base_model);
  const relation = normalizeRelation(frontmatter?.base_model_relation);

  const declaredBaseModels: DeclaredBaseModel[] = [];
  for (const entry of entries) {
    const repoSlug = repoSlugFromRef(entry);
    if (repoSlug === null) continue;
    declaredBaseModels.push({ repoSlug, relation, source: "card_data" });
  }

  return {
    description: descriptionFromCard(markdown),
    license: licenseFromCardData(frontmatter, repo),
    declaredBaseModels,
  };
}
