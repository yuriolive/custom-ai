"use client";

import { Tabs } from "@heroui/react";

import { LabelHint } from "@/components/label-hint";
import { MEASURED } from "@/lib/measured";

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
 * The three values are listed under the tabs as VALUES, with the caveat behind
 * an ⓘ tooltip. The caveats are each a paragraph and all three inline turned the
 * block into more text than the snippet it explains — in the Studio dialog they
 * pushed the snippet itself off the first screen. What stays visible is what a
 * developer scans for: the id, the URL, and the fact that the first call is slow.
 *
 * The cold-start warning specifically is a visible value, not a tooltip. A
 * developer whose first call takes two minutes without warning concludes the
 * product is broken and leaves — that has to be readable without hovering.
 *
 * `showNotes` EXISTS FOR THE LANDING PAGE AND ONLY FOR IT. On a model card and in
 * the Studio dialog this block is the only place the id, the endpoint and the
 * timeout are explained, so it defaults on. On `/` all three are already said,
 * larger and better: the base URL and the model id are the two-line diff in the
 * column beside this component, and the cold start has a section of its own.
 * Repeating them underneath is the "muito texto" the landing refresh was against.
 *
 * EVERY LATENCY FIGURE READS `MEASURED` (`lib/measured.ts`, sourced from
 * `docs/HANDOFF.md`). The timeout caveat used to say later calls answer "well
 * under a second", which is the same overstatement the proof strip and the
 * cold-start section carried: HANDOFF measures warm TTFT p50 at 926 ms and
 * records it as a MISS against NFR-CS-002's 400 ms — "recorded as a miss, not
 * restated to match what we measured". Interpolating rather than retyping is what
 * stops this drifting a third time.
 */
export function SnippetTabs({
  modelId,
  baseUrl,
  /** Rendered as a `<h_>`-free label; the surrounding card/dialog owns headings. */
  className,
  showNotes = true,
}: {
  modelId: string;
  baseUrl: string;
  className?: string;
  showNotes?: boolean;
}) {
  return (
    <div className={className}>
      <Tabs defaultSelectedKey="python">
        {/* Radii here have to nest, not merely match. HeroUI sizes the strip at
            `calc(--radius * 2.5)` = 20px, and `.tabs__list` insets the selected
            pill by 4px on every side. Concentric curves need
            inner = outer − inset, so the strip is 12px (`rounded-xl`) and the
            pill 8px (`rounded-lg`); giving both 12px leaves the pill's corner
            cutting across the strip's. */}
        <Tabs.ListContainer className="rounded-xl">
          <Tabs.List aria-label="Snippet language">
            {SNIPPET_LANGUAGES.map((language) => (
              <Tabs.Tab className="rounded-lg" id={language.id} key={language.id}>
                {language.label}
                <Tabs.Indicator className="rounded-lg" />
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

      {showNotes ? (
        <dl className="text-muted mt-3 grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 text-xs">
          <dt className="font-medium">Model id</dt>
          <dd className="flex min-w-0 items-start gap-1.5">
            {/* `break-all`, not `truncate`: an id or a URL that is cut off is a
                first call that does not run, and both are long enough to wrap in
                a dialog. */}
            <code className="text-foreground break-all">{modelId}</code>
            <LabelHint subject="the model id">
              The platform id — <code>creator-handle/model-slug</code>, not the Hugging Face repo
              path this model was built from. The handle need not match the HF account and the slug
              is chosen at registration. Case does not matter (the gateway lowercases it); the names
              do — a repo path that differs from this id returns 404 <code>model_not_found</code>.
            </LabelHint>
          </dd>
          <dt className="font-medium">Base URL</dt>
          <dd className="flex min-w-0 items-start gap-1.5">
            <code className="text-foreground break-all">{baseUrl}</code>
            <LabelHint subject="the base URL">
              The trailing <code>/v1</code> is part of it; SDKs append{" "}
              <code>/chat/completions</code>.
            </LabelHint>
          </dd>
          <dt className="font-medium">Timeout</dt>
          <dd className="flex min-w-0 items-start gap-1.5">
            <span className="text-foreground">
              {SNIPPET_TIMEOUT_SECONDS}s — a first call can take up to 2 min
            </span>
            <LabelHint subject="the timeout">
              This model scales to zero, so a first request to an idle worker waits while a GPU
              starts and the weights load — {MEASURED.coldStartSeconds}s measured on a first-ever
              start, {MEASURED.warmVolumeStartSeconds}s once its weights are cached. Later calls
              return their first token in {MEASURED.warmTtftMs} ms.
            </LabelHint>
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
