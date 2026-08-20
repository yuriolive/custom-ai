/**
 * A creator's monogram, used wherever a model is named.
 *
 * A LETTER, not a logo. Every product this competes with puts a provider icon
 * beside each model, and those are real trademarks belonging to OpenAI, Google
 * and Anthropic. This is a marketplace of models published by whoever signed
 * up: there are no logos to use, nothing to fetch them from, and inventing an
 * avatar service to host them is not what a model picker needs. A monogram
 * gives the same thing the icon actually provides — a fixed anchor your eye
 * lands on while scanning a list — with no assets, no network and nothing to
 * misattribute.
 *
 * Neutral by design. A deterministic hue per handle would scan slightly better
 * and would also be a second colour ramp to keep correct in both themes, which
 * `docs/DESIGN.md` spent real effort removing. The surface tokens already
 * separate it from the row behind it.
 */
export function CreatorBadge({
  className,
  handle,
  size = "sm",
}: Readonly<{
  className?: string;
  /** Platform creator handle. Lowercase by schema CHECK. */
  handle: string;
  size?: "sm" | "md";
}>) {
  // `Array.from`, not `handle[0]`: a handle is user-chosen text and indexing a
  // string splits a surrogate pair down the middle, which renders as a tofu box.
  const initial = (Array.from(handle.trim())[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={[
        "bg-surface-secondary text-muted border-border flex shrink-0 items-center justify-center rounded-md border font-medium select-none",
        size === "sm" ? "size-5 text-[10px]" : "size-7 text-xs",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {initial}
    </span>
  );
}
