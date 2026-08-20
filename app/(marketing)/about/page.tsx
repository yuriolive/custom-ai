import type { Metadata } from "next";
import Link from "next/link";

import { MarketingContainer, Section } from "@/components/marketing/section";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { siteEmailAddress } from "@/lib/seo/site-url";

/**
 * `/about` — what this is, why it works the way it does, and where it actually
 * is today.
 *
 * WRITTEN ABOUT THE SYSTEM, NOT ABOUT A COMPANY. An about page is where a young
 * product is most tempted to invent a founding story, a team photo and a funding
 * round, and inventing any of those would be a fabricated record about real
 * people. So this page is about the engineering, which is real and checkable,
 * and the two things it cannot know — who operates it and where — are constants
 * below that render nothing until they are set.
 *
 * The numbers quoted are the measured ones from `docs/HANDOFF.md`, and they are
 * attributed to the model and tier they were measured on. A per-model decode
 * rate reprinted as a platform-wide headline is the kind of number that gets
 * quoted back at you by someone whose model is half the speed.
 */

/**
 * The people or company behind the service. Empty until there is a real answer:
 * the section renders only when it is set. Whatever goes here should match the
 * `LEGAL_ENTITY` on `/legal/terms`.
 */
const OPERATOR = "";

const TITLE = "About";
const DESCRIPTION =
  "An inference marketplace for open models: creators deploy from Hugging Face, the " +
  "platform picks the cheapest GPU that meets both the memory fit and the speed target, " +
  "and consumers pay per token through an OpenAI-compatible endpoint.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: pageOpenGraph({ title: TITLE, description: DESCRIPTION, path: "/about" }),
};

function Note({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className="border-border flex flex-col gap-2 border-t py-6">
      <dt className="text-sm font-semibold tracking-tight">{term}</dt>
      <dd className="text-muted text-sm leading-[1.65]">{children}</dd>
    </div>
  );
}

export default function AboutPage() {
  const contact = siteEmailAddress("hello");

  return (
    <MarketingContainer>
      <Section
        eyebrow="What this is"
        id="what"
        lede="A marketplace for open models. A creator points it at a Hugging Face repo; it works out what the weights need, picks hardware, deploys, tests, and lists the model. A consumer calls it with the OpenAI SDK they already have and pays per token."
        title="Open models, priced per token"
      >
        <dl className="max-w-2xl">
          <Note term="The problem it solves for the person calling">
            Open models are cheap to run and awkward to reach. The closed APIs will not serve a
            quantized, fine-tuned or uncensored model at all, and the alternative — renting a GPU by
            the hour — means paying for silence between requests and doing the capacity arithmetic
            yourself. Here the unit is a token.
          </Note>

          <Note term="The problem it solves for the person publishing">
            Putting a model behind an API is mostly infrastructure work that has nothing to do with
            the model: hardware sizing, a serving runtime, autoscaling, metering, billing, payouts.
            That work is the platform. What is left for the creator is the model and its price, and
            80% of what it earns.
          </Note>

          <Note term="Migration is two lines">
            The endpoint speaks the OpenAI wire format. Change <code>base_url</code> and{" "}
            <code>api_key</code> and leave the rest of your code alone — that is the whole
            integration, and it is the reason the surface area of this product is deliberately
            small.
          </Note>
        </dl>
      </Section>

      <Section
        eyebrow="How it works"
        id="how"
        lede="Four steps, and the interesting one is the third."
        title="From a repo to a served model"
      >
        <dl className="max-w-2xl">
          <Note term="1. Probe the repository">
            The platform reads the repo, parses GGUF headers, and classifies what is actually in
            there — which quantizations exist, how big each one is, and the attention geometry the
            memory arithmetic needs. A repo usually holds many variants; a deployment is exactly one
            of them.
          </Note>

          <Note term="2. Work out what it needs">
            Weights, KV cache and overhead, computed rather than guessed. The KV term uses the
            model&rsquo;s declared key length, not the hidden size divided by head count, and it
            accounts for hybrid attention/SSM models keeping a cache on only some layers. Get either
            wrong and you buy a GPU two sizes too large.
          </Note>

          <Note term="3. Pick the cheapest GPU that actually fits — and is fast enough">
            The tier list is not a ladder. Memory bandwidth sets decode speed and does not track
            VRAM: the L40S has more memory than an A100-40GB and less bandwidth, and the L4 and A10
            hold the same weights at very different speeds. So selection is the cheapest tier
            meeting BOTH the memory fit and the creator&rsquo;s throughput target — never the
            biggest card, and never a menu handed to someone who should not have to care.
          </Note>

          <Note term="4. Test it before anyone can call it">
            A model is smoke-tested against the real worker before it is listed, and that test is
            billed to nobody: the platform pays for proving a model works. A deployment that cannot
            answer never reaches the catalog.
          </Note>
        </dl>
      </Section>

      <Section
        eyebrow="Decisions"
        id="decisions"
        lede="The choices that are load-bearing, including the ones with a real cost attached."
        title="What we decided on purpose"
      >
        <dl className="max-w-2xl">
          <Note term="Models sleep, and that costs you latency">
            Nothing is kept warm, which is why there is no hourly bill and why idle costs you
            nothing. The trade is the first request. On the reference deployment: 115 seconds the
            very first time, 23 seconds once the weights are cached on the volume, and under a
            second when the model is warm. We would rather publish those three numbers than one
            flattering one.
          </Note>

          <Note term="Money is integers, all the way down">
            Every amount is an integer count of millionths of a dollar, and no floating-point number
            touches a monetary path anywhere — not in the database, not in the application, not on
            the wire. Billing bugs that round in the platform&rsquo;s favour are not acceptable, and
            the only reliable way to not have them is to make them unrepresentable.
          </Note>

          <Note term="Reasoning tokens are billed as output, and counted">
            A model that thinks before it answers is generating the whole time. Counting only the
            visible reply would undercount a reasoning turn severely — so the meter counts both, and
            the pricing page says so rather than leaving you to discover it.
          </Note>

          <Note term="Open models are served as they are">
            We do not wrap a creator&rsquo;s weights in a moderation layer of our own. That is a
            real position with a real limit attached, and the limit has its own page: the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/acceptable-use">
              acceptable use policy
            </Link>{" "}
            binds every request regardless of what any model is willing to produce.
          </Note>
        </dl>
      </Section>

      <Section
        eyebrow="Status"
        id="status"
        lede="Where this genuinely is, rather than where it would be flattering to say it is."
        title="Early, and saying so"
      >
        <dl className="max-w-2xl">
          <Note term="It is a young product">
            The catalog is small, there is no uptime commitment, and parts of the roadmap —
            automated creator payouts among them — are accrued in the ledger but not yet disbursed
            automatically. That is stated here and in the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/terms">
              terms
            </Link>{" "}
            rather than discovered later.
          </Note>

          <Note term="Numbers here are measured, not modelled">
            The figures above came off a real deployment and are recorded with their conditions.
            Where a measurement missed its target internally, it was written down as a miss rather
            than restated to match. That habit is the main thing worth knowing about how this is
            built.
          </Note>

          {OPERATOR ? <Note term="Who runs it">{OPERATOR}</Note> : null}

          <Note term="Getting in touch">
            <a className="text-accent underline underline-offset-4" href={`mailto:${contact}`}>
              {contact}
            </a>{" "}
            for anything general. Abuse reports and privacy requests have their own addresses, on
            the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/acceptable-use">
              acceptable use
            </Link>{" "}
            and{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/privacy">
              privacy
            </Link>{" "}
            pages.
          </Note>
        </dl>
      </Section>

      <Section eyebrow="Next" id="start" title="Have a look">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-10 items-center rounded-full px-5 text-sm font-medium transition-opacity duration-[--motion-fast] hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
            href="/models"
          >
            Browse the catalog
          </Link>
          <Link
            className="text-foreground hover:text-accent focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href="/pricing"
          >
            How pricing works &rarr;
          </Link>
        </div>
      </Section>
    </MarketingContainer>
  );
}
