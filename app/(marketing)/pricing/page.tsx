import type { Metadata } from "next";
import Link from "next/link";

import { MarketingContainer, Section } from "@/components/marketing/section";
import { pageOpenGraph } from "@/lib/seo/open-graph";

/**
 * `/pricing` — the page whose absence is loudest.
 *
 * Every comparable platform has one (OpenRouter, Together, Venice, Modal,
 * OrcaRouter), and a marketplace that quotes per-token prices on model cards but
 * has no page explaining what a token costs reads as unfinished
 * (docs/SEO-PAGES-PLAN.md §P2).
 *
 * STATIC ON PURPOSE. There is no per-model price table here and there must not
 * be one: price is a column on `custom_models`, set by each creator, so any
 * table on this page would be a second source of truth that goes stale the first
 * time a creator edits their model. The prices live in the catalog; this page
 * explains the RULES, which are the same for every model and change only when
 * the billing contract does.
 *
 * So the page itself needs nothing per-request — no database read, no cookie,
 * no `force-dynamic`. It is still listed as server-rendered on demand in the
 * build output, and that is not this file's doing: `SiteNav` in the root layout
 * is an async Server Component that reads the session, which opts every route in
 * the app out of static generation. Worth knowing before someone adds a fetch
 * here believing the route was already dynamic for a reason.
 *
 * Server Component with no `@heroui/react` import, so it stays server-rendered
 * and indexable (FR-MKT-006), same discipline as the landing sections.
 */

const TITLE = "Pricing";
const DESCRIPTION =
  "Pay per token from a prepaid wallet — no subscription, no hourly GPU bill, no charge " +
  "for idle time. Creators set each model's price and keep 80%; the platform takes 20%.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: pageOpenGraph({ title: TITLE, description: DESCRIPTION, path: "/pricing" }),
};

/** A term and its explanation. The page is mostly this shape. */
function Fact({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className="border-border flex flex-col gap-2 border-t py-6">
      <dt className="text-sm font-semibold tracking-tight">{term}</dt>
      <dd className="text-muted text-sm leading-[1.65]">{children}</dd>
    </div>
  );
}

export default function PricingPage() {
  return (
    <MarketingContainer>
      <Section
        eyebrow="Pricing"
        id="model"
        lede="You fund a wallet, then you pay for the tokens you actually send and receive. There is no plan to choose, no minimum monthly spend, and no bill for a model sitting idle."
        title="Per token, from a prepaid balance"
      >
        <dl className="max-w-2xl">
          <Fact term="Prompt and completion are priced separately">
            Every model carries two prices — one per million prompt tokens, one per million
            completion tokens — because generating a token costs far more than reading one. Both are
            set by the model&rsquo;s creator and shown on its catalog page.
          </Fact>

          <Fact term="Reasoning counts as output">
            On a reasoning model, the tokens it thinks with are billed like the tokens it answers
            with. Counting only the visible answer would under-report a long chain-of-thought turn
            by a wide margin, so the meter counts both.
          </Fact>

          <Fact term="Idle costs you nothing">
            Models scale to zero. Nobody is paying for a warm GPU between your requests, so nothing
            is passed on to you for one. The trade is latency, not money: the first request to a
            cold model can take up to two minutes while weights load, and warm requests answer
            immediately.
          </Fact>

          <Fact term="Your balance cannot go negative">
            A request is authorized against your balance before it runs and settled against the
            tokens it actually used. If the balance will not cover it, the request is refused rather
            than run on credit.
          </Fact>
        </dl>
      </Section>

      <Section
        eyebrow="Revenue share"
        id="split"
        lede="A model on this marketplace belongs to whoever deployed it. They set its price, and they keep most of what it earns."
        title="Creators keep 80%"
      >
        <dl className="max-w-2xl">
          <Fact term="80% creator, 20% platform">
            Every settled request splits the same way. The creator&rsquo;s share accrues to their
            earnings balance; the platform&rsquo;s 20% covers the GPU time, the gateway and the
            wallet rails.
          </Fact>

          <Fact term="The creator sets the price, not us">
            Studio shows a creator what the hardware their model landed on costs to run, so they can
            price above it. We do not set a floor and we do not mark their price up in the middle —
            the number on the model page is the number you pay.
          </Fact>

          <Fact term="Deployment testing is on us">
            Before a model is listed it is smoke-tested against the real worker. That test costs GPU
            time and produces no billable usage — the platform pays for it, and neither the creator
            nor the first caller is charged for proving the model works.
          </Fact>
        </dl>
      </Section>

      <Section
        eyebrow="Wallet"
        id="wallet"
        lede="Balance is added by card checkout and drawn down per request. It is prepaid, so there is no invoice and no end-of-month surprise."
        title="Funding your balance"
      >
        <dl className="max-w-2xl">
          <Fact term="$5 minimum, $500 per top-up">
            A single top-up is between $5 and $500, and an account holds at most $2,000 at a time.
            The ceilings exist to keep a compromised account from being an attractive target, not to
            push you toward a bigger plan.
          </Fact>

          <Fact term="Card details never reach us">
            Checkout is hosted by Stripe. This deployment never sees a card number, and the balance
            only moves when Stripe&rsquo;s signed webhook says the payment cleared — a success
            redirect on its own credits nothing.
          </Fact>

          <Fact term="Every movement is auditable">
            Top-ups, per-request debits, refunds and reversals are all rows in a ledger that must
            sum to your balance. Your{" "}
            <Link className="text-accent underline underline-offset-4" href="/console/usage">
              usage page
            </Link>{" "}
            shows what each request cost, per request, not as a monthly aggregate.
          </Fact>
        </dl>
      </Section>

      <Section
        eyebrow="Next"
        id="start"
        lede="Prices differ per model, so the honest answer to “what does it cost?” is on the model itself."
        title="See what a model actually costs"
      >
        {/* Same lockup as the hero (components/marketing/hero.tsx): a filled
            pill and a bare text link. Anchors, not HeroUI Buttons — v3's Button
            is a React Aria <button> and takes no href (DESIGN.md §6 item 15). */}
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-10 items-center rounded-full px-5 text-sm font-medium transition-opacity duration-[--motion-fast] hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
            href="/models"
          >
            Browse the catalog
          </Link>
          <Link
            className="text-foreground hover:text-accent focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href="/playground"
          >
            Try one in the playground &rarr;
          </Link>
        </div>
      </Section>
    </MarketingContainer>
  );
}
