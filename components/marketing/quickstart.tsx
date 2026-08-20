import { SnippetTabs } from "@/components/marketplace/snippet-tabs";

import { Section } from "./section";

/**
 * Section 3 — the two-line diff (docs/UI-REDESIGN-PLAN.md §4).
 *
 * The strongest claim this product makes is that switching costs two lines, and
 * a claim like that is worth more shown than stated. The section is a `Section`
 * header over `SnippetTabs` — the SAME component the model card and the model
 * detail page use, deliberately, because it is the one place the model id, the
 * base URL and the 180-second timeout are constructed correctly (snippets.ts
 * lists all three failure modes). A second code component written for marketing
 * is a second place for a snippet to go stale, and a stale snippet on the
 * landing page is the most expensive one to have.
 *
 * The two changed lines are called out beside the tabs rather than highlighted
 * inside the code. Highlighting would mean teaching the highlighter about
 * line-level emphasis in three grammars at once, for an effect a two-item list
 * delivers exactly.
 */
export function Quickstart({ modelId, baseUrl }: Readonly<{ modelId: string; baseUrl: string }>) {
  return (
    <Section
      eyebrow="Compatibility"
      id="quickstart"
      lede="No SDK to install and no wire format to learn. Point the OpenAI client you already have at this base URL, name a model, and everything downstream of it keeps working."
      title="Two lines, and your existing client is done"
    >
      {/* `grid-cols-[minmax(0,1fr)]` on the BASE breakpoint, not only at `lg:`.
          Without it the sub-`lg` single column is an `auto` track, an `auto`
          track is at least `min-content` wide, and this grid's `min-content` is
          set by the code block's longest unbreakable line — so at 390px the
          grid measured 830px and put a horizontal scrollbar on the whole
          document. `minmax(0, …)` is what lets a track be narrower than its
          content and hands the overflow back to `CodeBlock`, which already
          scrolls internally. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-10">
        <dl className="flex flex-col gap-6">
          <Change label="base_url" value={baseUrl} />
          <Change label="model" value="creator-handle/model-slug" />
          <div className="glass-panel-secondary border-border rounded-lg border p-4">
            <p className="text-muted text-sm leading-[1.55]">
              Streaming, <code className="text-foreground">usage</code>, stop sequences and
              temperature behave the way your client expects. Tool calling is not wired up yet — it
              is on the roadmap and it is not claimed here until it is.
            </p>
          </div>
        </dl>

        <SnippetTabs baseUrl={baseUrl} modelId={modelId} />
      </div>
    </Section>
  );
}

function Change({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-accent font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      {/* `break-all`: the gateway base URL is one unbroken token and long enough
          to overflow a 22rem column, which on a phone becomes a horizontal
          scrollbar on the whole document. */}
      <dd className="text-foreground font-mono text-sm break-all">{value}</dd>
    </div>
  );
}
