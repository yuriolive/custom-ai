import "server-only";

/**
 * The Hugging Face model card's opening paragraph, as a suggested description.
 *
 * WHY THIS IS NOT IN `@nexus/hf-probe`: that package answers "what can be
 * deployed and what is its memory profile" — questions with exact answers that
 * 65 tests pin down. This is prose extraction for a form field the creator can
 * overwrite, and a heuristic has no business inside the classifier that decides
 * whether a 3 GB file is a servable model.
 *
 * It is advisory in every direction. A missing card, a private repo, a network
 * failure and an unparseable README all produce `null`, and the form simply
 * leaves the field empty — the creator was always going to be able to write
 * their own. Nothing downstream depends on this succeeding.
 */

const CARD_MAX_CHARS = 600;

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
function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/<[^>]+>/g, "")
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

/** Fetch and extract. Never throws — a failure is simply "no suggestion". */
export async function fetchCardDescription(
  slug: string,
  revision: string,
  opts: { hfToken?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const url = `https://huggingface.co/${slug}/raw/${encodeURIComponent(revision)}/README.md`;
  try {
    const response = await fetch(url, {
      headers: opts.hfToken ? { authorization: `Bearer ${opts.hfToken}` } : {},
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    // A model card is prose. Anything of this size is not one, and reading it
    // in full would hand a route worker an unbounded body.
    const text = (await response.text()).slice(0, 200_000);
    return descriptionFromCard(text);
  } catch {
    return null;
  }
}
