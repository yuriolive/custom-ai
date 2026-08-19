import type { Route } from "next";
import Link from "next/link";

/**
 * The product wordmark, in one place.
 *
 * It was inlined in `site-nav.tsx` and is about to be needed by the marketing
 * nav, the marketing footer, the auth pages and the app sidebar. Four copies of
 * a lockup is four places for it to drift, and the drift is always the same one:
 * somebody colours a half of it with the accent.
 *
 * DO NOT COLOUR ANY PART OF THIS GREEN (docs/DESIGN.md §3.1). The accent is
 * spent on the primary CTA and the active nav item; a green wordmark makes both
 * of those read as decoration. The product name is a path, so the suffix is set
 * in mono — that is where its character comes from, not from colour.
 */
export function Wordmark({
  className,
  href = "/",
}: Readonly<{ className?: string; href?: Route }>) {
  return (
    <Link
      aria-label="Nexus Inference — home"
      className={[
        "text-foreground focus-visible:ring-accent rounded-sm font-semibold tracking-tight",
        "focus-visible:ring-2 focus-visible:outline-none",
        className ?? "",
      ].join(" ")}
      href={href}
    >
      nexus
      <span className="text-muted font-mono text-sm font-normal"> / inference</span>
    </Link>
  );
}
