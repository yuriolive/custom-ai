import { jsonLdScriptContent, type JsonLdNode } from "@/lib/seo/json-ld";

/**
 * Renders one JSON-LD node into the document.
 *
 * `dangerouslySetInnerHTML` is required here and is not a shortcut: React
 * escapes text children, and an escaped `&quot;` inside a `<script>` is not
 * valid JSON — the block would parse as nothing and the structured data would
 * silently not exist. Safety comes from `jsonLdScriptContent`, which serializes
 * with `JSON.stringify` and escapes `<`, so creator-supplied text cannot close
 * the tag early.
 *
 * A Server Component with no `"use client"`: this markup has to be in the HTML a
 * crawler receives, not injected after hydration.
 */
export function JsonLdScript({ node }: Readonly<{ node: JsonLdNode }>) {
  return (
    <script
      dangerouslySetInnerHTML={{ __html: jsonLdScriptContent(node) }}
      type="application/ld+json"
    />
  );
}
