"use client";

import { Alert, Chip } from "@heroui/react";

import { SNIPPET_TIMEOUT_SECONDS } from "./snippets";

/**
 * What this product is, for someone who has never heard of it.
 *
 * The catalog below is meaningless to a first-time visitor who does not know
 * what they are looking at, so the page leads with the three things that decide
 * whether they stay: what it does, what it costs them to try, and the one way it
 * differs from the hosted API they already use.
 *
 * THE COLD START IS STATED UP FRONT, IN THE LARGEST PIECE OF COPY ON THE PAGE.
 * Models scale to zero, so a first request can take up to two minutes. That is a
 * real tradeoff, not a defect — it is the reason a niche model is affordable at
 * all — but a developer who meets it by surprise, after a snippet appears to hang
 * for ninety seconds, concludes the product is broken and never comes back.
 * Burying it below the fold would be the single most expensive omission on this
 * page.
 */
export function HomeIntro({ baseUrl }: { baseUrl: string }) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-4">
        <Chip color="accent" variant="soft">
          OpenAI-compatible · pay per token
        </Chip>

        <h1 className="max-w-3xl text-3xl leading-[1.1] font-semibold tracking-[-0.03em] sm:text-4xl">
          Run open models nobody else hosts, behind one endpoint you already know how to call
        </h1>

        <p className="text-muted max-w-2xl text-base">
          Creators deploy models from Hugging Face — quantized, uncensored, fine-tuned, whatever the
          big providers will not host — and this marketplace makes each one callable at{" "}
          <code className="text-foreground text-sm">POST /v1/chat/completions</code>. Change two
          lines in your OpenAI client and it works: the base URL and the model id. You pay per
          token, with no hourly GPU bill and no minimum, and 80% of what you pay goes to the creator
          of the model.
        </p>
      </div>

      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>
            The tradeoff: models sleep, so the first call can take up to two minutes
          </Alert.Title>
          <Alert.Description>
            <span className="block">
              Nothing here runs on an idle GPU waiting for you. When a model has had no traffic, the
              next request has to start a worker and load weights from disk before it can emit a
              token — typically 20 to 100 seconds, occasionally up to two minutes for a large one.
              Once warm, the same model answers in well under a second and streams at its listed
              speed until it goes idle again.
            </span>
            <span className="mt-2 block">
              That is the deal that makes a 27B model cost cents instead of dollars an hour. It only
              bites if it surprises you, so:{" "}
              <strong>
                set your client timeout to at least {SNIPPET_TIMEOUT_SECONDS}
                &nbsp;seconds
              </strong>{" "}
              — every snippet on this site already does — and treat the first call of a session as a
              warm-up rather than a benchmark.
            </span>
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <ol className="grid gap-4 sm:grid-cols-3">
        <Step
          n={1}
          title="Pick a model"
          body="Every card shows measured throughput, context window, quality level and both token prices. Filter by what you need; the hardware behind it is our problem."
        />
        <Step
          n={2}
          title="Create a key"
          body="Sign up and mint an sk-plat-… key in the Console. Your balance is prepaid, so a runaway loop cannot invoice you."
        />
        <Step n={3} title="Point your client at it">
          <span className="block">Set your OpenAI base URL to</span>
          <code className="text-foreground mt-1 block text-xs break-all">{baseUrl}</code>
          <span className="mt-1 block">
            and the model to <code>creator-handle/model-slug</code>.
          </span>
        </Step>
      </ol>
    </section>
  );
}

function Step({
  n,
  title,
  body,
  children,
}: {
  n: number;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="border-border bg-surface flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-accent font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        Step {n}
      </span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted text-sm">{body}</span>
      {children}
    </li>
  );
}
