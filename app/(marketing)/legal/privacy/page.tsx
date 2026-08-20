import type { Metadata } from "next";
import Link from "next/link";

import { MarketingContainer, Section } from "@/components/marketing/section";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { siteEmailAddress } from "@/lib/seo/site-url";

/**
 * `/legal/privacy` — what is stored, what is not, and who else sees it.
 *
 * THIS IS THE PAGE WHERE A FABRICATED SENTENCE DOES THE MOST DAMAGE. Every claim
 * below was checked against the schema or the code that writes it, and where the
 * answer is "we do not know", the page says so rather than reassuring:
 *
 *   - the per-request row (`usage_transactions`, 20260817000900) holds counts,
 *     ids, money and timestamps, and has no column for message text;
 *   - `GatewayLog` in `supabase/functions/gateway/index.ts` is a fixed field set
 *     carrying the same shape of data, with an invariant comment forbidding
 *     message content, keys and generated tokens;
 *   - `api_keys` stores a hash, never the plaintext (CONTRACTS.md);
 *   - a creator's Hugging Face token goes to Vault as a secret id, never into a
 *     column;
 *   - the repo carries no analytics, product-telemetry or advertising script —
 *     verified by grep, and that is why the cookies section is as short as it is.
 *
 * What the page does NOT claim is that no prompt text exists anywhere. The
 * inference worker runs llama.cpp under Modal and inherits its stdout; the
 * platform does not persist prompts, but a blanket "nothing is ever logged
 * anywhere" would cover a process this codebase does not control. The honest
 * sentence is the narrower one.
 *
 * NOT LEGAL ADVICE AND NOT REVIEWED BY COUNSEL. A GDPR/CCPA-shaped policy needs
 * a controller identity and a lawful basis per purpose, and both wait on the
 * legal entity that `/legal/terms` also leaves unset.
 */

/** Fixed for the same reason as the terms page: see the note there. */
const LAST_UPDATED = "19 August 2026";

const TITLE = "Privacy";
const DESCRIPTION =
  "What this platform stores about you and what it does not. The billing record for a " +
  "request holds token counts, ids and money — not the text of your prompt or the " +
  "model's reply. No analytics scripts, no advertising cookies, no training on your data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/legal/privacy" },
  openGraph: pageOpenGraph({ title: TITLE, description: DESCRIPTION, path: "/legal/privacy" }),
};

function Item({ term, children }: Readonly<{ term: string; children: React.ReactNode }>) {
  return (
    <div className="border-border flex flex-col gap-2 border-t py-6">
      <dt className="text-sm font-semibold tracking-tight">{term}</dt>
      <dd className="text-muted text-sm leading-[1.65]">{children}</dd>
    </div>
  );
}

export default function PrivacyPage() {
  const privacyContact = siteEmailAddress("privacy");

  return (
    <MarketingContainer>
      <Section
        eyebrow={`Last updated ${LAST_UPDATED}`}
        id="summary"
        lede="Written from the schema rather than from a template, so every claim here is one you could check by reading the code that writes the row."
        title="What we store"
      >
        <dl className="max-w-2xl">
          <Item term="Your account">
            An email address and the credentials behind it, held by our authentication provider. On
            top of that: the handle you chose, and a display name, avatar and bio if you set them.
            The handle is public — it is half of every model id you publish.
          </Item>

          <Item term="Your API keys, as hashes">
            A key is generated once, shown once, and stored only as a hash. We cannot display an
            existing key to you, and we could not disclose one if compelled. What we keep alongside
            it is the label you gave it, when it was last used, and a request count.
          </Item>

          <Item term="One row per request">
            Each call writes a billing record: a request id, which model and which key, the token
            counts, the price in force, the cost and the 80/20 split, and timings. That is the row
            in full. There is no column for the text of your prompt or the model&rsquo;s reply, so
            no version of that row contains them.
          </Item>

          <Item term="Your balance, as ledger entries">
            Top-ups, per-request debits, refunds and reversals, each referencing the payment
            processor&rsquo;s own object id so a balance can always be traced back to a real event.
            Card numbers never reach this service; checkout is hosted by Stripe.
          </Item>

          <Item term="What creators add">
            The Hugging Face repo, revision and variant you deployed, the model card you wrote, and
            the hardware the solver picked. A token for a private repo is stored as an encrypted
            secret and referenced by id — it is never written into a table column, never logged, and
            never returned by any endpoint.
          </Item>

          <Item term="Operational logs">
            The gateway writes one structured line per request with the same shape of data as the
            billing row — ids, counts, timings, an error code. The field set is fixed in code and
            the rule attached to it is explicit: no message content, no API key, no bearer header,
            no generated tokens.
          </Item>
        </dl>
      </Section>

      <Section
        eyebrow="Not collected"
        id="not-collected"
        lede="Stated as narrowly as it is true. Where the honest answer has an edge, the edge is here rather than omitted."
        title="What we do not store"
      >
        <dl className="max-w-2xl">
          <Item term="Prompts and completions are not persisted">
            The platform does not write your prompt or the model&rsquo;s reply to any store. They
            exist in memory for the length of the request and in the response you receive.
          </Item>

          <Item term="The edge of that claim">
            Your prompt necessarily reaches the GPU platform — that is where the model runs and how
            the request gets answered. The inference server there writes its own operational output
            to that provider&rsquo;s logs, and we neither collect that output nor control what it
            contains. So the claim above is deliberately about what this platform persists, and not
            the broader &ldquo;nothing is ever written anywhere by anyone&rdquo;, which would cover
            software we do not run. If you need a hard guarantee for regulated data, ask before you
            send it.
          </Item>

          <Item term="No training on your data">
            We do not use what you send to train, fine-tune or evaluate a model, we build no dataset
            from it, and we grant nobody else the right to. The claim is written about what we do
            and what we license, because those are the two things we can actually answer for.
          </Item>

          <Item term="No selling, no ad tech">
            We do not sell personal data and we do not share it with advertisers. There is no
            advertising or data-broker relationship to disclose.
          </Item>
        </dl>
      </Section>

      <Section
        eyebrow="Cookies"
        id="cookies"
        lede="Short, because there is genuinely little here — the site carries no analytics or product-telemetry script at all."
        title="Cookies and the browser"
      >
        <dl className="max-w-2xl">
          <Item term="A session cookie, when you sign in">
            Signing in sets an authentication cookie, which is refreshed as you navigate and is what
            keeps you signed in. Signing out clears it. There is no way to use an account without
            it.
          </Item>

          <Item term="A theme preference">
            Light or dark is remembered in your browser&rsquo;s own storage. It never reaches the
            server and is not tied to your account.
          </Item>

          <Item term="Nothing else">
            No analytics, no session replay, no advertising or cross-site tracking cookies. That is
            why this site shows no cookie banner: there is nothing to ask you to consent to beyond
            the cookie that signs you in.
          </Item>
        </dl>
      </Section>

      <Section
        eyebrow="Third parties"
        id="processors"
        lede="Running this service means handing parts of it to other companies. Each keeps its own logs under its own policy."
        title="Who else processes your data"
      >
        <dl className="max-w-2xl">
          <Item term="Hosting, database and authentication">
            The application is hosted on Vercel and the database, authentication and storage are
            Supabase. Both keep infrastructure logs, which ordinarily include IP addresses and
            request metadata.
          </Item>

          <Item term="Payments">
            Stripe handles checkout and holds the card details we never see. What comes back to us
            is an object id, an amount and a status.
          </Item>

          <Item term="Inference">
            Models run on Modal&rsquo;s GPU platform. A request&rsquo;s content passes through it in
            order to be answered.
          </Item>

          <Item term="Model weights">
            Weights are pulled from Hugging Face when a creator deploys. That is a creator-side
            interaction and does not involve a consumer&rsquo;s data.
          </Item>
        </dl>
      </Section>

      <Section
        eyebrow="Your data"
        id="rights"
        lede="Including how the current answer is manual, because pointing you at a self-serve button that does not exist would waste your time."
        title="Retention, access and deletion"
      >
        <dl className="max-w-2xl">
          <Item term="How long things are kept">
            Billing records and ledger entries are kept while they matter for accounting and dispute
            handling — they are the audit trail behind real money and cannot simply be erased on
            request. Account details are kept while the account exists.
          </Item>

          <Item term="Access, correction and deletion">
            You can edit your display name, avatar and bio in the console, and delete API keys
            yourself. Your handle cannot change: model ids that other people have written into their
            code must not move underneath them. For a copy of your data or deletion of your account,
            email us — there is no self-serve button for either yet, and this page will say so until
            there is.
          </Item>

          <Item term="Contact">
            Privacy questions and requests go to{" "}
            <a
              className="text-accent underline underline-offset-4"
              href={`mailto:${privacyContact}`}
            >
              {privacyContact}
            </a>
            . For what you may do with the service, see the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/acceptable-use">
              acceptable use policy
            </Link>{" "}
            and the{" "}
            <Link className="text-accent underline underline-offset-4" href="/legal/terms">
              terms
            </Link>
            .
          </Item>
        </dl>
      </Section>
    </MarketingContainer>
  );
}
