import type { Metadata } from "next";
import Link from "next/link";

import { MarketingContainer, Section } from "@/components/marketing/section";
import { pageOpenGraph } from "@/lib/seo/open-graph";

/**
 * `/legal/acceptable-use` — the rules that bind both sides of the marketplace.
 *
 * WHY A PLATFORM THAT LISTS UNCENSORED MODELS NEEDS THIS MOST, not least. The
 * catalog carries models with no refusal training, and the honest position is
 * that we do not add a moderation layer on top of a creator's weights. A page
 * that says only that reads as an invitation. This one draws the line the
 * product cannot draw for itself: the model will answer, and answering is still
 * not permission.
 *
 * WRITTEN AS POLICY, NOT AS A CONTRACT. It states what is prohibited, who is
 * responsible for what, and what happens when a rule is broken, in language a
 * developer can act on. It is deliberately NOT the Terms of Service, which is a
 * separate document and does not exist yet.
 *
 * Static: no database, no per-request anything. Like every route it is still
 * listed as dynamic in the build output, because `SiteNav` in the root layout
 * reads the session.
 */

/**
 * PLACEHOLDER — MUST BE SET BEFORE THIS PAGE IS PUBLIC. An abuse policy whose
 * reporting address does not resolve is worse than no policy: it invites a
 * report and then drops it, and "nobody told us" stops being true the moment
 * someone tries. Point this at a mailbox a human actually reads.
 */
const ABUSE_CONTACT = "abuse@nexus-inference.example";

const TITLE = "Acceptable use policy";
const DESCRIPTION =
  "What you may and may not do with the models on this platform, who is responsible for " +
  "prompts, outputs and deployed weights, and what happens when a rule is broken. Open " +
  "models are served without an added moderation layer — that is not permission.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/legal/acceptable-use" },
  openGraph: pageOpenGraph({
    title: TITLE,
    description: DESCRIPTION,
    path: "/legal/acceptable-use",
  }),
};

function Rule({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className="border-border flex flex-col gap-2 border-t py-6">
      <dt className="text-sm font-semibold tracking-tight">{term}</dt>
      <dd className="text-muted text-sm leading-[1.65]">{children}</dd>
    </div>
  );
}

export default function AcceptableUsePage() {
  return (
    <MarketingContainer>
      <Section
        eyebrow="Policy"
        id="scope"
        lede="These rules bind everyone who calls the API and everyone who lists a model. They are policy, not legal advice, and they sit alongside the Terms of Service rather than replacing it."
        title="Acceptable use"
      >
        <dl className="max-w-2xl">
          <Rule term="What “open and unfiltered” means here">
            The catalog carries open models, including ones with little or no refusal training. We
            do not wrap a creator&rsquo;s weights in a moderation layer of our own, and we do not
            silently rewrite prompts. What a model will answer is a property of that model, chosen
            by the creator who deployed it.
          </Rule>

          <Rule term="What it does not mean">
            That a model answers is not permission to ask. The rules below apply to every request
            regardless of which model served it, and a model&rsquo;s willingness to produce
            something has no bearing on whether producing it was allowed. If you want a platform
            that refuses on your behalf, this is not it — the refusal here is ours, after the fact,
            and it costs you your account.
          </Rule>
        </dl>
      </Section>

      <Section
        eyebrow="Prohibited"
        id="prohibited"
        lede="Not an exhaustive list, and not softened by intent, by framing, or by the claim that the output was for research."
        title="What you may not do"
      >
        <dl className="max-w-2xl">
          <Rule term="Sexual content involving minors">
            Any sexual depiction of a minor, generated or otherwise, real or fictional, in any
            modality. There is no exception, no research carve-out and no artistic one. This is the
            one rule where we act first and ask afterwards.
          </Rule>

          <Rule term="Material harm to identifiable people">
            Sexual imagery of a real person without their consent, harassment or stalking campaigns,
            doxxing, or content built to threaten or intimidate a specific person. Impersonating a
            real person or organisation in order to deceive.
          </Rule>

          <Rule term="Weapons and mass-casualty capability">
            Working instructions for chemical, biological, radiological or nuclear weapons, or for
            explosives and untraceable firearms. General science is not the target here; the line is
            operational uplift.
          </Rule>

          <Rule term="Attacks on systems you do not own">
            Malware, ransomware, exploit development against systems you have no permission to test,
            credential-stuffing tooling, or evasion of another party&rsquo;s security controls.
            Authorized security work is fine and is not what this covers.
          </Rule>

          <Rule term="Fraud and deception at scale">
            Phishing, scam infrastructure, fake reviews or engagement, disinformation campaigns, or
            generating identity documents and financial records that are then presented as genuine.
          </Rule>

          <Rule term="Exploiting your own users">
            Building on this API an application that hides from its users that they are talking to a
            model where that matters — medical, legal, financial and crisis contexts — or that
            presents model output to them as professional advice.
          </Rule>
        </dl>
      </Section>

      <Section
        eyebrow="Responsibility"
        id="responsibility"
        lede="A marketplace has two sides, and they answer for different things."
        title="Who is responsible for what"
      >
        <dl className="max-w-2xl">
          <Rule term="If you call the API, the request is yours">
            You are responsible for the prompts you send, for what you do with the output, and for
            the conduct of any application you build on top. That includes requests your own users
            cause your application to make: an API key is yours to protect, and traffic under it is
            attributed to you.
          </Rule>

          <Rule term="Output is generated, not verified">
            Models produce plausible text, and plausible is not the same as correct. Nothing
            returned by this API is checked by us, and none of it is medical, legal or financial
            advice.
          </Rule>

          <Rule term="If you list a model, the weights are yours">
            Deploying a model is a statement that you have the right to deploy it: that the licence
            permits hosted inference and commercial use, that the weights are what your model card
            says they are, and that restrictions attached by the original authors are respected. A
            model listed on false claims is delisted, and earnings accrued on it are withheld.
          </Rule>

          <Rule term="We do not read your prompts to enforce this">
            Enforcement is complaint-driven, not surveillance. The billing record for a request
            holds counts, ids and money — prompt tokens, completion tokens, the price snapshot and
            the split — and not the text of your prompt or the model&rsquo;s reply. That is a real
            constraint on what we are able to produce if someone asks us for it.
          </Rule>
        </dl>
      </Section>

      <Section
        eyebrow="Enforcement"
        id="enforcement"
        lede="What actually happens, so that it is not a surprise."
        title="How we act"
      >
        <dl className="max-w-2xl">
          <Rule term="The graduated path">
            Most problems end with a warning and a fix. Past that: revoking an API key, delisting a
            model, suspending an account, and withholding earnings tied to the violation. We aim to
            say which rule was broken and to give you a way to respond.
          </Rule>

          <Rule term="Where we skip to the end">
            Sexual content involving minors, credible threats against a specific person, and active
            attacks launched from this platform get an immediate suspension with no prior notice.
            The account owner is told after the fact, not before.
          </Rule>

          <Rule term="Reporting something">
            Send it to{" "}
            <a
              className="text-accent underline underline-offset-4"
              href={`mailto:${ABUSE_CONTACT}`}
            >
              {ABUSE_CONTACT}
            </a>
            . Include the model id and, where you have it, the request id returned with the response
            — that id is how one specific request gets found. Reports about a model itself rather
            than about a request are useful too: a model listed under false claims is a problem
            whether or not anyone has called it yet.
          </Rule>

          <Rule term="Legal process">
            We respond to valid legal process. What can be handed over is bounded by what is kept,
            which is described above: identity and billing records exist, and prompt and output text
            is not part of them.
          </Rule>
        </dl>
      </Section>

      <Section eyebrow="Elsewhere" id="related" title="Related">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="text-foreground hover:text-accent focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href="/pricing"
          >
            Pricing and the revenue split &rarr;
          </Link>
          <Link
            className="text-foreground hover:text-accent focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href="/models"
          >
            Browse the catalog &rarr;
          </Link>
        </div>
      </Section>
    </MarketingContainer>
  );
}
