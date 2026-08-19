import { Wordmark } from "@/components/wordmark";

/**
 * Shell for /login and /signup — a two-panel page (UI-REDESIGN-PLAN §7, L7).
 *
 * This layout SUPERSEDES `docs/DESIGN.md` §3.7's "a form on a ground" rule,
 * reversed by the owner on 2026-08-18. The rest of §3.7 still binds — in
 * particular there is no hero art, no gradient and no illustration here, and
 * every figure in the panel is a restatement of copy already on the marketplace
 * home page rather than a new claim.
 *
 * Plain markup only — no HeroUI import — so this stays a Server Component
 * (§4.1.0: `@heroui/react` is client-only).
 *
 * `min-h-dvh` on the grid, not `calc(100dvh - <nav height>)`: the old magic
 * number encoded the nav height as a constant and broke the moment that height
 * changed.
 *
 * Below `lg:` the right panel is not rendered at all and the form column is the
 * whole page, which is exactly the previous layout — mobile does not regress.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="grid min-h-dvh w-full lg:grid-cols-[1fr_minmax(0,26rem)] xl:grid-cols-2">
      <div className="flex w-full items-center justify-center px-4 py-10 sm:py-12">
        <div className="flex w-full max-w-[24rem] flex-col gap-7">
          <Wordmark />
          {children}
        </div>
      </div>

      <ProofPanel />
    </div>
  );
}

/**
/**
 * Right column: a field of `--surface` separated from the form by a hairline,
 * never a shadow (DESIGN §elevation). Text only — no illustration, no gradient.
 *
 * IT IS DELIBERATELY QUIETER THAN THE FORM. The first version set these figures
 * at `text-xl font-semibold` while HeroUI's `.card__title` rendered "Sign in" at
 * `text-sm` — so the marketing out-shouted the only thing the page is for, and
 * the eye landed on "80%" instead of on the email field. A panel beside a form
 * is context, not the headline: the figures sit at `text-base`, the heading of
 * the form sits at `text-xl`, and that ordering is the point.
 *
 * Three figures, not four. Every one restates copy that already exists on
 * `components/marketplace/home-intro.tsx`; nothing here is a new claim.
 */
function ProofPanel() {
  return (
    <aside className="border-border bg-surface hidden flex-col justify-center gap-8 border-l px-10 py-12 lg:flex xl:px-14">
      <div className="flex max-w-sm flex-col gap-3">
        <Wordmark />
        <p className="text-muted text-[0.9375rem] leading-[1.6]">
          Open models nobody else hosts, behind one endpoint you already know how to call. You pay
          per token, and most of what you pay goes to whoever published the model.
        </p>
      </div>

      <dl className="flex max-w-sm flex-col gap-5">
        <Figure
          figure="80%"
          label="To the creator"
          note="of what a model bills goes to whoever deployed it."
        />
        <Figure
          figure="Two lines"
          label="To switch"
          note="the base URL and the model id in the OpenAI client you already have."
        />
        <Figure
          figure="Prepaid"
          label="Your balance"
          note="keys draw down funds you added, so a runaway loop cannot invoice you."
        />
      </dl>
    </aside>
  );
}

function Figure({ label, figure, note }: { label: string; figure: string; note: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      <dd className="flex flex-col gap-0.5">
        <span className="text-base font-semibold tracking-[-0.01em] tabular-nums">{figure}</span>
        <span className="text-muted text-sm leading-[1.5]">{note}</span>
      </dd>
    </div>
  );
}
