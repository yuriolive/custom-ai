/**
 * Splits a reply into prose and fenced code blocks.
 *
 * This is NOT a Markdown renderer and does not want to become one. A model
 * answering "write me a retry helper" produces one thing that plain text really
 * does ruin — a code block — and one affordance that matters, copying it. The
 * rest of Markdown (emphasis, headings, tables) degrades acceptably as plain
 * text, and rendering it properly means a parser dependency and an HTML
 * sanitiser on a string an untrusted model produced. That trade is not worth
 * making for italics.
 *
 * Streaming is the reason for the `closed` flag. Half a fence arrives on its own
 * constantly, and an open block has to render as a code block immediately or the
 * transcript visibly reflows when the closing fence lands.
 */

export type Segment =
  | { type: "text"; text: string }
  | { type: "code"; code: string; language: string | null; closed: boolean };

const FENCE_RE = /^[ \t]*```([^\n`]*)$/u;

export function splitSegments(input: string): Segment[] {
  if (input.length === 0) return [];

  const lines = input.split("\n");
  const segments: Segment[] = [];

  let buffer: string[] = [];
  let codeLanguage: string | null = null;
  let inCode = false;

  const flushText = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    buffer = [];
    // Whitespace-only runs between two fences are separators, not content.
    if (text.trim().length > 0) segments.push({ type: "text", text });
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);

    if (fence && !inCode) {
      flushText();
      inCode = true;
      const info = (fence[1] ?? "").trim();
      codeLanguage = info.length > 0 ? info.split(/\s+/u)[0]! : null;
      continue;
    }

    if (fence && inCode) {
      segments.push({
        type: "code",
        code: buffer.join("\n"),
        language: codeLanguage,
        closed: true,
      });
      buffer = [];
      codeLanguage = null;
      inCode = false;
      continue;
    }

    buffer.push(line);
  }

  if (inCode) {
    segments.push({
      type: "code",
      code: buffer.join("\n"),
      language: codeLanguage,
      closed: false,
    });
  } else {
    flushText();
  }

  return segments;
}
