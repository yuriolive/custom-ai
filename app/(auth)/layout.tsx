import { Wordmark } from "@/components/wordmark";

/**
 * Shell for /login and /signup.
 *
 * ONE CENTRED COLUMN. A two-panel version shipped briefly — form left, a
 * `--surface` proof panel right — and was removed by the owner on sight. It is
 * worth recording why rather than leaving the next person to rediscover it,
 * because the panel read fine in the abstract and badly on the screen:
 *
 *  - The root layout renders `SiteNav` above this, so the panel could not reach
 *    the top of the viewport. It started under the nav and ended at the fold,
 *    which made a full-height design element read as a floating slab.
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
 * Plain markup only — no HeroUI import — so this stays a Server Component
 * (PRD §4.1.0: `@heroui/react` is client-only).
 *
 * `min-h-[60dvh]`, not `100dvh` and not a `calc()` against the nav height: the
 * nav is rendered by an ancestor and its height is not this layout's business,
 * so anything subtracting a constant from the viewport goes stale the moment
 * that height changes. 60dvh centres the card on a tall screen without pushing
 * the page past the fold on a short one.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-[60dvh] w-full items-center justify-center px-4 py-10 sm:py-16">
      <div className="flex w-full max-w-[24rem] flex-col gap-6">
        {/* The lockup on the page, not only in the nav. A sign-in box with no
            branding is the thing that reads as unfinished — and it is the one
            piece of the removed panel that was doing real work. */}
        <Wordmark />
        {children}
      </div>
    </div>
  );
}
