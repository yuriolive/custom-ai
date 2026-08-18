"use client";

import { Tabs } from "@heroui/react";

import { CodeBlock } from "./code-block";
import { SNIPPET_LANGUAGES, SNIPPET_TIMEOUT_SECONDS, snippetFor } from "./snippets";

/**
 * The most important element on the page (FR-MKT-008).
 *
 * Everything else on a model card is a claim; this is the thing a developer
 * actually takes away. It is only worth anything if it runs unmodified, which
 * comes down to three values none of which are typed by hand here:
 *
 *  - the model id, built from `creator_handle/slug` in queries.ts — NOT the
 *    Hugging Face repo path, which 404s as `model_not_found`;
 *  - the base URL, derived from the deployment's own Supabase URL by
 *    `gatewayBaseUrl`, so a local build never hands out a production endpoint;
 *  - the timeout, which must survive a cold start.
 *
 * The cold-start note under the tabs is deliberately above the fold rather than
 * buried in the snippet comments. A developer whose first call takes 100 seconds
 * without warning concludes the product is broken and leaves.
 */
export function SnippetTabs({
  modelId,
  baseUrl,
  /** Rendered as a `<h_>`-free label; the surrounding card/dialog owns headings. */
  className,
}: {
  modelId: string;
  baseUrl: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Tabs defaultSelectedKey="python">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Snippet language">
            {SNIPPET_LANGUAGES.map((language) => (
              <Tabs.Tab id={language.id} key={language.id}>
                {language.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        {SNIPPET_LANGUAGES.map((language) => (
          <Tabs.Panel className="pt-3" id={language.id} key={language.id}>
            <CodeBlock
              code={snippetFor(language.id, { modelId, baseUrl })}
              grammar={language.grammar}
              label={language.label}
            />
          </Tabs.Panel>
        ))}
      </Tabs>

      <dl className="text-muted mt-3 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">Model id</dt>
        <dd>
          <code className="text-foreground">{modelId}</code> — the platform id. It is a{" "}
          <em>platform</em> identity, not the Hugging Face repo path this model was built from: the
          creator handle need not match the HF account, and the slug is chosen at registration. Case
          does not matter (the gateway lowercases what you send), but the two names do — send a repo
          path that differs from the id above and you get 404 <code>model_not_found</code>.
        </dd>
        <dt className="font-medium">Base URL</dt>
        <dd>
          <code className="text-foreground">{baseUrl}</code> — the trailing <code>/v1</code> is part
          of it; SDKs append <code>/chat/completions</code>.
        </dd>
        <dt className="font-medium">Timeout</dt>
        <dd>
          {SNIPPET_TIMEOUT_SECONDS}s, and it matters. This model scales to zero, so a first request
          to an idle worker can take up to two minutes while a GPU starts and weights load. Later
          calls answer in well under a second.
        </dd>
      </dl>
    </div>
  );
}
