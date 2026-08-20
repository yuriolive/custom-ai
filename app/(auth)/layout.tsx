import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Wordmark } from "@/components/wordmark";

/**
 * Shell for /login and /signup.
 *
 * ONE CENTRED COLUMN. A two-panel version shipped briefly — form left, a
 * `--surface` proof panel right — and was removed by the owner on sight. It is
 * worth recording why rather than leaving the next person to rediscover it,
 * because the panel read fine in the abstract and badly on the screen:
 *
 *  - There is a nav above this, so the panel could not reach the top of the
 *    viewport. It started under the nav and ended at the fold, which made a
 *    full-height design element read as a floating slab.
 *  - Its content is vertically centred and short, so the top third was an empty
 *    field of `--surface` — a large, conspicuously blank rectangle above the
 *    only thing on the page worth looking at.
 *  - It competed with the form for a page that has exactly one job.
 *
 * This restores `docs/DESIGN.md` §3.7: "A sign-in page for a developer product
 * is a form on a ground." That rule was reversed during the redesign and is now
 * reinstated, which makes it the second time it has been argued and the second
 * time it has won. Do not add a panel, a hero, a gradient or an illustration
 * here without a stronger reason than "the reference sites have one".
 *
 * `MarketingNav`, not `SiteNav`: the nav used to come from the root layout, and
 * when the marketing split moved it out this page had to name one. The marketing
 * pill is the correct one — `SiteNav` carries a `BalanceChip`, and a wallet
 * balance above a sign-in form is furniture for a session that by definition
 * does not exist yet.
 *
 * Plain markup only — no HeroUI import — so this stays a Server Component
 * (PRD §4.1.0: `@heroui/react` is client-only).
 *
 * The card is centred by `flex-1` on the `<main>`, not by a `calc()` against the
 * nav height. The nav's height is not this layout's business, so anything
 * subtracting a constant from the viewport goes stale the moment that height
 * changes — which is exactly what the previous `min-h-[calc(100dvh-8rem)]` did.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <MarketingNav />
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:py-16">
        <div className="flex w-full max-w-[24rem] flex-col gap-6">
          {/* The lockup on the page, not only in the nav. A sign-in box with no
              branding is the thing that reads as unfinished — and it is the one
              piece of the removed panel that was doing real work. */}
          <Wordmark />
          {children}
        </div>
      </main>
    </div>
  );
}
