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
    <div className="grid min-h-dvh w-full lg:grid-cols-2">
      <div className="flex w-full items-start justify-center px-4 py-6 sm:items-center sm:py-12">
        <div className="flex w-full max-w-[26rem] flex-col gap-6">
          <Wordmark className="text-lg" />
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
 * Every figure below is already stated on the marketplace home page
 * (`components/marketplace/home-intro.tsx`); nothing here is a new claim.
 */
function ProofPanel() {
  return (
    <aside className="border-border bg-surface hidden flex-col justify-center gap-10 border-l p-12 lg:flex">
      <div className="flex max-w-md flex-col gap-4">
        <Wordmark className="text-xl" />
        <p className="text-muted text-base leading-[1.65]">
          Open models nobody else hosts, behind one endpoint you already know how to call — you pay
          per token, and most of what you pay goes to the person who published the model.
        </p>
      </div>

      <dl className="flex max-w-md flex-col gap-6">
        <Figure
          figure="80%"
          label="To the creator"
          note="of what a model bills goes to whoever deployed it."
        />
        <Figure
          figure="2 lines"
          label="To switch"
          note="the base URL and the model id in your existing OpenAI client — the endpoint is OpenAI-compatible."
        />
        <Figure
          figure="Per token"
          label="How billing works"
          note="no hourly bill and no minimum; you are charged for the tokens you actually use."
        />
        <Figure
          figure="Prepaid"
          label="Your balance"
          note="keys draw down a balance you funded, so a runaway loop cannot invoice you."
        />
      </dl>
    </aside>
  );
}

function Figure({ label, figure, note }: { label: string; figure: string; note: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      <dd className="flex flex-col gap-1">
        <span className="text-xl font-semibold tracking-[-0.02em] tabular-nums">{figure}</span>
        <span className="text-muted text-sm leading-[1.55]">{note}</span>
      </dd>
    </div>
  );
}
