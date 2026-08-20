import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  formatContext,
  formatPricePerMtoken,
  formatSpeed,
  qualityLabel,
} from "@/components/marketplace/format";
import { ModelDetail } from "@/components/marketplace/model-detail";
import { fetchModelByHandleAndSlug } from "@/components/marketplace/queries";
import { gatewayBaseUrl } from "@/components/marketplace/snippets";
import type { CatalogModel } from "@/components/marketplace/types";
import { JsonLdScript } from "@/components/seo/json-ld-script";
import { buildModelApplication, buildModelBreadcrumbs } from "@/lib/seo/json-ld";
import { pageOpenGraph } from "@/lib/seo/open-graph";
import { SUPABASE_URL } from "@/lib/supabase/public-config";
import { createClient } from "@/lib/supabase/server";

/**
 * `/models/[creator]/[slug]` — the addressable page for one model (FR-MKT-007).
 *
 * The route segments ARE the model id: `jonathancoletti/qwen3.8-27b-uncensored-gguf`
 * is served at `/models/jonathancoletti/qwen3.8-27b-uncensored-gguf`. That is not
 * cosmetic — it means the URL a developer shares and the string they pass as
 * `model` are the same two tokens, so the snippet on the page cannot drift from
 * the page it is on.
 *
 * A Server Component, so the metadata below is real HTML in the first response
 * rather than something a crawler or a Slack unfurl has to run JavaScript to see.
 */

type Params = { creator: string; slug: string };

/**
 * Segments are matched case-sensitively against lowercase-by-CHECK columns, so a
 * mixed-case URL is normalised here rather than 404-ing. Someone who copies
 * `JonathanColetti/Qwen3.8-…` out of Hugging Face and pastes it after `/models/`
 * lands on the right page — the friendlier half of the model-id trap, since the
 * gateway itself still requires the exact lowercase id.
 */
async function readParams(params: Promise<Params>): Promise<Params> {
  const { creator, slug } = await params;
  return {
    creator: decodeURIComponent(creator).toLowerCase(),
    slug: decodeURIComponent(slug).toLowerCase(),
  };
}

/**
 * `cache()` because Next calls `generateMetadata` and the page in the same
 * request, and both need the row. Keyed on the resolved strings rather than on
 * the `params` promise, whose identity is not guaranteed to be shared between the
 * two calls — without that, the page would issue the same query twice.
 */
const getModel = cache(async (creator: string, slug: string): Promise<CatalogModel | null> => {
  const supabase = await createClient();
  return fetchModelByHandleAndSlug(supabase, creator, slug);
});

async function loadModel(params: Promise<Params>): Promise<CatalogModel | null> {
  const { creator, slug } = await readParams(params);
  return getModel(creator, slug);
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { creator, slug } = await readParams(params);
  const model = await loadModel(params);

  if (!model) {
    return {
      title: `${creator}/${slug} — not found`,
      robots: { index: false, follow: false },
    };
  }

  // "API" AND "PRICING" ARE IN THE TITLE ON PURPOSE, and they are the whole
  // reason this line is not just the model id and its numbers. The query a
  // developer types before they have chosen a provider is "<model> api pricing",
  // not "<model> tokens per second" — every comparable catalog that ranks for it
  // (OpenRouter, Together, Venice, OrcaRouter) carries both words in the title
  // tag. The numbers still do their work, one line down, in the description that
  // a search result and a Slack unfurl actually show.
  //
  // Kept short because the root layout appends ` | Nexus Inference`; a title
  // carrying speed and context as well ran past the width a result renders.
  const title = `${model.modelId} API — pricing, context & speed`;
  // The description is what shows up in a Slack unfurl and a search result, so
  // it carries the four numbers a developer decides on: speed, context, quality
  // and the output price.
  const description = [
    model.description?.replace(/\s+/g, " ").trim().slice(0, 140),
    `${formatSpeed(model.measuredTokensPerSecond)} · ${formatContext(model.contextLength)} context · ${qualityLabel(model.qualityTier)} · ${formatPricePerMtoken(model.priceCompletionMicroPerMtoken)} per 1M output tokens.`,
    "OpenAI-compatible. Scales to zero, so allow up to two minutes for a cold first request.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title,
    description,
    alternates: { canonical: `/models/${model.creatorHandle}/${model.slug}` },
    openGraph: pageOpenGraph({
      title,
      description,
      type: "article",
      path: `/models/${model.creatorHandle}/${model.slug}`,
      // `null`, not a path. The card lives in `opengraph-image.tsx` beside this
      // file, and Next serves a DYNAMIC route's generated image at a hashed
      // segment — so any path written here is both wrong and a 404. Leaving
      // `images` unset lets the file convention name its own route.
      imagePath: null,
    }),
    twitter: { card: "summary", title, description },
  };
}

export default async function ModelPage({ params }: { params: Promise<Params> }) {
  const model = await loadModel(params);

  // One 404 for "no such model", "private", "not ready" and "creator
  // suspended". Distinguishing them would tell an anonymous visitor that a
  // private model exists — the same reason the gateway answers 404 and not 403
  // (CONTRACTS.md §Gateway wire contract).
  if (!model) notFound();

  return (
    <>
      {/* Structured data for the one page on this site that describes a
          purchasable thing. Rendered here rather than in `ModelDetail` because
          that component is client-side (HeroUI v3), and JSON-LD has to be in the
          HTML a crawler receives. */}
      <JsonLdScript node={buildModelApplication(model)} />
      <JsonLdScript node={buildModelBreadcrumbs(model)} />

      <ModelDetail baseUrl={gatewayBaseUrl(SUPABASE_URL)} model={model} />
    </>
  );
}
