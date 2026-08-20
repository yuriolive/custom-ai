import type { Metadata } from "next";
import Link from "next/link";

import { MarketingContainer, Section } from "@/components/marketing/section";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { siteEmailAddress } from "@/lib/seo/site-url";

/**
 * `/legal/terms` — the agreement for using the marketplace, from both sides.
 *
 * WRITTEN FROM THE SCHEMA, not from a template. Every clause about money,
 * availability or ownership below describes something the code actually does:
 * the price snapshot taken at request time, the balance that cannot go negative,
 * the 80/20 split, scale-to-zero and its cold start. A terms page that promises
 * behaviour the system does not have is worse than none, because it is the
 * document someone quotes back at you.
 *
 * IT IS NOT LEGAL ADVICE AND HAS NOT BEEN REVIEWED BY COUNSEL. Two clauses that
 * every real ToS carries are deliberately ABSENT rather than invented: the
 * operating legal entity, and the governing law and dispute forum. Naming a
 * company that does not exist or a jurisdiction nobody chose would be a
 * fabricated legal record. `LEGAL_ENTITY` and `GOVERNING_LAW` below are the two
 * values a lawyer supplies; until they are set, the sections that depend on them
 * do not render at all, so the page never states something untrue.
 */

/**
 * MUST BE SET BY COUNSEL. The company that operates this service. Empty until
 * then — the "who you are contracting with" section renders only when it is set.
 */
const LEGAL_ENTITY = "";

/**
 * MUST BE SET BY COUNSEL. The governing law and the forum for disputes, e.g.
 * "the laws of the State of Delaware". Empty until then, and the section that
 * would state it renders only when it is set.
 */
const GOVERNING_LAW = "";

/**
 * Fixed, not `new Date()`. A "last updated" that moves on every render tells a
 * reader the terms changed today, every day, which is both false and the exact
 * signal this line exists to give honestly. Change it when the text changes.
 */
const LAST_UPDATED = "19 August 2026";

const TITLE = "Terms of service";
const DESCRIPTION =
  "The agreement for using the marketplace: accounts and API keys, prepaid per-token " +
  "billing, the 80/20 creator split, what is guaranteed about availability, and who owns " +
  "prompts, outputs and deployed weights.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/legal/terms" },
  openGraph: pageOpenGraph({ title: TITLE, description: DESCRIPTION, path: "/legal/terms" }),
};

function Clause({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className="border-border flex flex-col gap-2 border-t py-6">
      <dt className="text-sm font-semibold tracking-tight">{term}</dt>
      <dd className="text-muted text-sm leading-[1.65]">{children}</dd>
    </div>
  );
}

export default function TermsPage() {
  const legalContact = siteEmailAddress("legal");

  return (
    <MarketingContainer>
      <Section
        eyebrow={`Last updated ${LAST_UPDATED}`}
        id="scope"
        lede="Using the API, funding a balance, or listing a model means you accept these terms. They apply to both sides of the marketplace, and where a clause is about one side it says so."
        title="Terms of service"
      >
        <dl className="max-w-2xl">
          {LEGAL_ENTITY ? (
            <Clause term="Who you are contracting with">
              The service is operated by {LEGAL_ENTITY}. &ldquo;We&rdquo; and &ldquo;us&rdquo; below
              mean that company.
            </Clause>
          ) : null}

          <Clause term="What the service is">
            A marketplace for open models. Creators deploy weights from Hugging Face and set a
            price; consumers call them through one OpenAI-compatible endpoint and are billed per
            token from a prepaid balance. We operate the gateway, the billing and the hardware
            selection. We do not author the models.
          </Clause>

          <Clause term="The acceptable use policy is part of these terms">
            The{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/acceptable-use">
              acceptable use policy
            </Link>{" "}
            binds you as fully as the clauses here, and breaking it is a breach of these terms. It
            is a separate page because it is the one people need to read on its own.
          </Clause>
        </dl>
      </Section>

      <Section
        eyebrow="Account"
        id="account"
        lede="One account, and the keys under it are the credential that spends your money."
        title="Accounts and API keys"
      >
        <dl className="max-w-2xl">
          <Clause term="You are responsible for your keys">
            A key is shown once, at creation, and is never recoverable afterwards — we store only a
            hash of it. Every request made with a key is attributed to you and billed to your
            balance, including requests you did not intend. Revoke a key the moment you think it has
            leaked; revocation is immediate.
          </Clause>

          <Clause term="Accurate registration">
            Give real details when you register and keep them current. Accounts created to evade a
            prior suspension are terminated.
          </Clause>

          <Clause term="Your handle is permanent">
            The handle chosen at signup becomes half of every model id you publish, and it cannot be
            changed — model ids that other people have written into their code must not move
            underneath them.
          </Clause>
        </dl>
      </Section>

      <Section
        eyebrow="Money"
        id="billing"
        lede="Prepaid, per token, in integer micro-USD. There is no subscription and no invoice."
        title="Billing"
      >
        <dl className="max-w-2xl">
          <Clause term="You pay for tokens, both directions">
            Each model prices prompt and completion tokens separately, and on a reasoning model the
            tokens it thinks with are billed as output. A request is authorized against your balance
            before it runs and settled against the tokens it actually used.
          </Clause>

          <Clause term="The price is fixed when the request starts">
            The rates in force at the moment a request is authorized are snapshotted onto that
            request and are what settle it. A creator editing their price mid-flight cannot change
            what you are charged for a call already running.
          </Clause>

          <Clause term="Balance, limits and refunds">
            Top-ups are between $5 and $500, and an account holds at most $2,000. Balance never goes
            negative: a request that your balance will not cover is refused rather than run on
            credit. Tokens already served are not refundable. If a card payment is refunded or
            disputed after the fact, the corresponding balance is debited — floored at zero — and
            the account is flagged for review.
          </Clause>

          <Clause term="Payments are handled by Stripe">
            Checkout is hosted by Stripe and card details never reach this service. Balance moves
            only when Stripe&rsquo;s signed webhook confirms the payment cleared; a success redirect
            on its own credits nothing.
          </Clause>
        </dl>
      </Section>

      <Section
        eyebrow="Creators"
        id="creators"
        lede="Listing a model is a set of promises about weights you did not necessarily write."
        title="If you publish a model"
      >
        <dl className="max-w-2xl">
          <Clause term="80% of every settled request is yours">
            The platform retains 20%; the rest accrues to your earnings balance as each request
            settles. You set the price. We do not mark it up and we do not set a floor — Studio
            shows you what the hardware costs so you can price above it.
          </Clause>

          <Clause term="You warrant that you may deploy the weights">
            That the licence permits hosted and commercial inference, that the weights are what your
            model card says they are, and that restrictions the original authors attached are
            respected. You keep whatever rights you had in the model; we take only the licence
            needed to host and serve it while it is listed.
          </Clause>

          <Clause term="We can delist">
            A model that breaks the acceptable use policy, misrepresents itself, or cannot be served
            can be delisted. Earnings accrued on a model listed under false claims are withheld.
            Delisting stops new requests; it does not reverse settled ones.
          </Clause>
        </dl>
      </Section>

      <Section
        eyebrow="Content"
        id="content"
        lede="Three different things with three different owners, which is why this is its own section."
        title="Prompts, outputs and weights"
      >
        <dl className="max-w-2xl">
          <Clause term="Your prompts and outputs are yours">
            As between you and us, you keep whatever rights exist in what you send and what comes
            back. We claim no ownership of either. We take only the licence needed to transmit your
            request to the model and return the result.
          </Clause>

          <Clause term="We do not keep the text">
            The billing record for a request holds counts, ids and money — not the text of your
            prompt or the model&rsquo;s reply. Identity and billing records do exist, and we respond
            to valid legal process against what we actually hold.
          </Clause>

          <Clause term="Output is not warranted, and is not advice">
            Models produce plausible text and plausible is not correct. Nothing returned is checked
            by us, none of it is medical, legal or financial advice, and the same prompt may produce
            different output on different calls. Whether an output is protectable, or infringes
            something, is a question about that output and the law where you are — not something
            this service determines for you.
          </Clause>
        </dl>
      </Section>

      <Section
        eyebrow="Availability"
        id="availability"
        lede="Stated plainly because the architecture has one consequence people meet on their first call."
        title="What is and is not guaranteed"
      >
        <dl className="max-w-2xl">
          <Clause term="Models sleep">
            Nothing is kept warm for you, which is why there is no hourly bill. A first request to
            an idle model can take up to two minutes while weights load; warm requests answer
            immediately.
          </Clause>

          <Clause term="No uptime commitment">
            The service is provided as is and as available. There is no SLA, no support commitment
            and no guarantee that a given model stays listed — a creator can withdraw one at any
            time. Build accordingly: pin what you depend on and handle a model disappearing.
          </Clause>

          <Clause term="Limits and changes">
            We may apply rate limits, and we may change or discontinue parts of the service. Where a
            change would break working code we will try to give notice, but the service is early and
            this is not a promise of stability.
          </Clause>
        </dl>
      </Section>

      <Section eyebrow="Ending" id="termination" lede="" title="Termination, liability and changes">
        <dl className="max-w-2xl">
          <Clause term="Either side can end it">
            You can stop using the service and close your account at any time. We can suspend or
            terminate an account that breaches these terms or the acceptable use policy —
            immediately and without notice where the breach is severe, as that policy describes.
          </Clause>

          <Clause term="Balance is credit for inference, not a deposit">
            A funded balance is spendable on this platform and nothing else. It is not transferable
            to another account, not withdrawable as cash, and not convertible into anything. Buy
            what you intend to use.
          </Clause>

          <Clause term="Creator earnings accrue before they are paid">
            Each settled request credits your share to an earnings balance immediately and
            auditably. Disbursement of that balance is a separate, manual process today — accrual is
            what the platform runs automatically, and payout scheduling is not yet automated. An
            accrued balance is owed to you; the mechanism for moving it is still being built, and
            that is stated here rather than implied away.
          </Clause>

          <Clause term="Limitation of liability">
            To the extent the law allows, we are not liable for indirect or consequential loss, lost
            profits, or lost data arising from your use of the service, and our total liability for
            any claim is limited to what you paid us in the three months before it arose. Nothing
            here excludes liability that cannot lawfully be excluded.
          </Clause>

          <Clause term="Changes to these terms">
            We may update these terms. The date at the top of this page is when they last changed,
            and continuing to use the service after that date is acceptance. For a change that
            materially affects money or ownership we will notify account holders rather than relying
            on this page alone.
          </Clause>

          {GOVERNING_LAW ? (
            <Clause term="Governing law">These terms are governed by {GOVERNING_LAW}.</Clause>
          ) : null}

          <Clause term="Contact">
            Questions about these terms go to{" "}
            <a className="text-accent underline underline-offset-4" href={`mailto:${legalContact}`}>
              {legalContact}
            </a>
            . Abuse reports go to the address on the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/acceptable-use">
              acceptable use policy
            </Link>
            , which is read faster.
          </Clause>
        </dl>
      </Section>
    </MarketingContainer>
  );
}
