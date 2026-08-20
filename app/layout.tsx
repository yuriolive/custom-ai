import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { JsonLdScript } from "@/components/seo/json-ld-script";
import { SiteNav } from "@/components/site-nav";
import { ThemeProvider } from "@/components/theme-provider";
import { buildOrganization, buildWebSite } from "@/lib/seo/json-ld";
import { siteUrl } from "@/lib/seo/site-url";

import "./globals.css";

/**
 * Self-hosted at build time by `next/font`: no third-party request at runtime,
 * and a `size-adjust` fallback so swapping the face in costs no layout shift.
 *
 * Inter for prose and UI — its `tnum` figures are genuinely monospaced, which
 * is what makes `tabular-nums` hold a money column still. JetBrains Mono for
 * code and identifiers, where a slashed zero and unambiguous `1lI` are the
 * whole job when the thing on screen is an API key someone is about to retype.
 */
const sans = Inter({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-sans-face",
});

const mono = JetBrains_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-mono-face",
  weight: ["400", "500"],
});

const BRAND = "Nexus Inference";

/**
 * The one description a search engine shows when it has nothing better: the
 * catalog's own `generateMetadata` overrides it, and every page that lands after
 * this one should too. It names the substitution a developer is actually
 * evaluating — swap two arguments in the `openai` SDK — rather than the
 * category, because "inference marketplace" is a phrase people type only after
 * they already know the product exists.
 */
const DESCRIPTION =
  "Call open Hugging Face models — quantized, uncensored, fine-tuned — through one " +
  "OpenAI-compatible endpoint. Change `base_url` and `api_key` and nothing else. " +
  "Per-token pricing from a prepaid wallet, with no hourly GPU bill to keep alive.";

/**
 * `default` is what a segment WITHOUT its own title inherits; `template` wraps
 * the title a CHILD segment sets. They are different fields on purpose and a
 * page never gets both.
 *
 * The template does not reach `app/page.tsx`. Next only promotes a template
 * once it has descended past the segment that declared it — a layout and the
 * page beside it are the same segment — so the home page's title stands alone,
 * unbranded and untouched, which is also why it must not be given a bare brand
 * suffix here.
 */
const TITLE = {
  default: `${BRAND} — serverless inference marketplace`,
  template: `%s | ${BRAND}`,
} as const;

export const metadata: Metadata = {
  // Without this, every relative canonical, OG and Twitter URL in the app
  // resolves against localhost:3000 at BUILD time and ships that way.
  metadataBase: siteUrl(),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: BRAND,
  // A child that declares `openGraph` REPLACES this object; the two are not
  // deep-merged. So everything here is a fallback for pages that stay silent,
  // and a page that writes its own `openGraph` inherits none of it — including
  // the `app/opengraph-image.tsx` card, which is attached to this object and
  // vanishes with it — verified: `/login`, which stays silent, carries the
  // card; `/pricing`, which does not, emits no `og:image` at all. A page that
  // overrides `openGraph` has to restate `siteName`, `locale` and an `images`
  // entry (its own, or `/opengraph-image` for the site card).
  openGraph: {
    type: "website",
    siteName: BRAND,
    locale: "en_US",
    // `"./"` is resolved against the CURRENT pathname, not against the segment
    // that wrote it, so each page claims itself. A literal `"/"` here would
    // hand every page in the app the home page's URL, and an unfurl follows
    // `og:url` — a shared /pricing link would open the catalog.
    url: "./",
    title: TITLE,
    description: DESCRIPTION,
  },
  // Card size only. Giving this a title or a description would freeze both:
  // Next copies `og:title`/`og:description` into the Twitter tags ONLY when
  // they are absent here, so a page that overrides its Open Graph copy and
  // leaves `twitter` alone would unfurl the root's boilerplate on X while
  // showing its own on every other network.
  //
  // `summary_large_image` matches the 1200x630 of `app/opengraph-image.tsx`.
  // The image is copied across from Open Graph by the same fallback, which is
  // why there is no `twitter-image` file — a second copy of one PNG is just a
  // second thing to forget to update.
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning is required (FR-UI-003): next-themes writes
    // `class` and `data-theme` on <html> before React hydrates, so the server
    // and client markup differ on this element by design.
    <html className={`${sans.variable} ${mono.variable}`} lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground font-sans min-h-dvh antialiased">
        {/* Site-wide structured data. Emitted once, from the root, because
            `Organization` and `WebSite` describe the site rather than any page —
            repeating them per route would give a crawler several `@id`s for one
            entity. The logo points at the Open Graph card because that is the
            only brand image this deployment actually serves; a dedicated logo
            file is worth adding, and this line is where it would go. */}
        <JsonLdScript node={buildOrganization({ name: BRAND, logoPath: "/opengraph-image" })} />
        <JsonLdScript node={buildWebSite({ name: BRAND })} />

        {/* No <HeroUIProvider>. HeroUI v3 has no provider. */}
        <ThemeProvider>
          <SiteNav />
          <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
          {/* MOUNTED HERE, not per marketing page, because the footer is where
              the legal and policy links live and a policy nobody can reach from
              the product is not a policy. `MarketingFooter` was built for the
              landing-page redesign and until now was rendered by nothing at
              all — so `/pricing` and `/legal/acceptable-use` were reachable
              only by typing the URL. */}
          <MarketingFooter />
        </ThemeProvider>
      </body>
    </html>
  );
}
