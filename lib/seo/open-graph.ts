import type { Metadata } from "next";

/**
 * The Open Graph block for a page that needs its own title and description.
 *
 * WHY THIS EXISTS. Next does not deep-merge `openGraph`: a page that declares
 * one REPLACES the root layout's object outright, and the `opengraph-image.tsx`
 * file convention is attached to that object — so it vanishes along with
 * `siteName` and `locale`. The failure is silent and invisible in the app; it
 * shows up only as a link that unfurls with no card. Verified in the rendered
 * HTML: `/login`, which declares no `openGraph`, carries the card; a page that
 * declares one and stops there emits no `og:image` at all.
 *
 * So every page that overrides `openGraph` goes through here, and the defaults
 * live in one file rather than being restated — and forgotten — per page.
 */

const SITE_NAME = "Nexus Inference";

/**
 * The site card. Referenced by path rather than imported: `app/opengraph-image.tsx`
 * is a route, and this is the URL it serves at.
 */
const SITE_CARD = "/opengraph-image";

export function pageOpenGraph({
  title,
  description,
  path,
  type = "website",
  imagePath = SITE_CARD,
}: Readonly<{
  title: string;
  description: string;
  /**
   * The page's own absolute path, e.g. `/pricing`. Relative to `metadataBase`,
   * so no origin here.
   *
   * NOT optional and NOT defaulted to `"./"`. The root layout can use `"./"`
   * because Next resolves it against whatever pathname is rendering; a page
   * already knows its own URL, and passing it explicitly means a copy-pasted
   * block cannot quietly claim to be a different page.
   */
  path: string;
  /** `"article"` for a model page, which has an author and a subject. */
  type?: "website" | "article";
  /**
   * Which card this page unfurls with.
   *
   * Omit it for the site card, which is the right answer for every page whose
   * subject is the site. Pass `null` when the page has an `opengraph-image` file
   * COLOCATED WITH IT: Next fills `images` in from that file, but only if this
   * object does not already set it, so naming a path here would beat the very
   * card it was meant to select.
   *
   * DO NOT HARDCODE A DYNAMIC ROUTE'S CARD PATH. For a route with params Next
   * serves the generated image at a hashed segment
   * (`/models/[creator]/[slug]/opengraph-image-1hsxkq`), so `…/opengraph-image`
   * is a 404 — which is exactly what a hardcoded path here produced until the
   * landing rebuild surfaced it. `null` lets Next name its own route.
   */
  imagePath?: string | null;
}>): NonNullable<Metadata["openGraph"]> {
  return {
    type,
    siteName: SITE_NAME,
    locale: "en_US",
    url: path,
    title,
    description,
    // Absent, not empty: an `images: []` would still count as "set" and would
    // suppress the colocated file convention just as a wrong path did.
    ...(imagePath === null ? {} : { images: [imagePath] }),
  };
}
