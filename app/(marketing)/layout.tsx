import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";

/**
 * The marketing shell — `/` and nothing else, today.
 *
 * FULL BLEED, and that is the whole reason this group exists. The landing page's
 * hero paints a gradient and a lit 3D lattice to the viewport edges; a
 * `max-w-6xl` `<main>` (which is what the root layout used to impose on every
 * route) would have boxed that into a column and left two grey gutters beside it.
 * Sections do their own centring via `MarketingContainer`, so the width decision
 * lives with the section that needs it rather than with the shell.
 */
export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // NO `overflow-x-hidden` HERE, and that is a fix rather than an omission.
    // It was on this element to contain the hero's glow overhang, and it broke
    // `MarketingNav`'s `sticky top-4`: any `overflow` other than `visible` makes
    // the element a scroll container, and a descendant `sticky` then sticks to
    // THAT container's scrollport rather than the viewport — so the nav scrolled
    // away with the page instead of following it down. Containment belongs to the
    // element that overflows, so the hero clips its own glow.
    <div className="flex min-h-dvh flex-col">
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
