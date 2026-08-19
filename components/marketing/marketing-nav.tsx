import Link from "next/link";

import { UserMenu } from "@/components/auth/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSessionProfile } from "@/lib/supabase/server";

import { MARKETING_LINKS } from "./links";
import { MarketingMenu } from "./marketing-menu";
import { Wordmark } from "@/components/wordmark";

/**
 * The marketing nav (docs/UI-REDESIGN-PLAN.md §4).
 *
 * A FLOATING PILL, not a bar — measured off modal.com, which renders
 * `<nav class="rounded-full grid grid-cols-[1fr_auto_1fr]">` at 48px on a
 * `max-w-[1400px]` container. The three-column grid is the whole trick: it pins
 * the link row to the optical centre of the viewport regardless of how wide the
 * wordmark or the auth cluster get, which a flex row with `ml-auto` cannot do.
 *
 * WHERE WE DEPART FROM MODAL, deliberately:
 *
 *  - No drop shadow. Modal floats theirs on `0 10px 15px -3px`. DESIGN.md §1.5
 *    says elevation is a background step plus a 1px hairline and that nothing
 *    casts a shadow except an open Modal in light mode, so the pill separates
 *    from the page by sitting a step lighter (`--surface-secondary`) inside its
 *    own hairline ring. That reads as floating in both themes; a shadow only
 *    reads at all in light.
 *  - No backdrop blur. Modal does not use one either, and it costs a
 *    compositor layer on every scroll frame for an effect nothing here needs.
 *  - Our accent is not spent on the link text. Modal tints theirs `#ddffdc`.
 *    One green element per viewport (DESIGN.md §4 item 2) and on this surface
 *    it is the CTA.
 *
 * A SERVER COMPONENT: it reads the session here and passes a plain handle
 * string down, because `@heroui/react` is client-only (PRD §4.1.0).
 */
export async function MarketingNav() {
  const profile = await getSessionProfile();

  return (
    // `sticky top-4` with the container's own padding is what makes it read as
    // floating ON the page rather than as a header attached to its top edge.
    <header className="sticky top-4 z-40 px-4 sm:px-6">
      <nav
        aria-label="Main"
        className="border-border bg-surface-secondary mx-auto grid h-12 w-full max-w-7xl grid-cols-[1fr_auto] items-center gap-4 rounded-full border px-2 pl-4 sm:px-3 sm:pl-5 md:grid-cols-[1fr_auto_1fr]"
      >
        <Wordmark />

        {/* The centre column exists only from `md:` up. Below that the grid is
            two columns and this is not rendered at all — a link row cannot fit
            beside a wordmark and an auth cluster at 375px, so it moves into the
            Drawer instead of wrapping the pill into two lines. */}
        <ul className="hidden items-center gap-6 md:flex">
          {MARKETING_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                className="text-muted hover:text-foreground focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors duration-[--motion-fast] focus-visible:ring-2 focus-visible:outline-none"
                href={link.href}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* `min-w-0` lets this cluster shrink. Without it a long handle forces a
            document overflow at 375px — the exact bug site-nav.tsx records
            having had. */}
        <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
          <ThemeToggle />

          {profile ? (
            <>
              <Link
                className="text-muted hover:text-foreground focus-visible:ring-accent hidden rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none md:inline"
                href="/console"
              >
                Console
              </Link>
              <span className="hidden md:inline">
                <UserMenu handle={profile.handle} />
              </span>
            </>
          ) : (
            <>
              <Link
                className="text-muted hover:text-foreground focus-visible:ring-accent hidden rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none md:inline"
                href="/login"
              >
                Sign in
              </Link>
              {/* An anchor, not a <Button>: HeroUI v3's Button is a React Aria
                  <button> and takes no href (DESIGN.md §6 item 15). This is the
                  one accent-filled element on the surface. */}
              <Link
                className="bg-accent text-accent-foreground focus-visible:ring-accent hidden h-8 items-center rounded-full px-4 text-sm font-medium transition-opacity duration-[--motion-fast] hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none md:inline-flex"
                href="/signup"
              >
                Get started
              </Link>
            </>
          )}

          <span className="md:hidden">
            <MarketingMenu isSignedIn={profile !== null} links={MARKETING_LINKS} />
          </span>
        </div>
      </nav>
    </header>
  );
}
