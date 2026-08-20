import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { ImageResponse } from "next/og";

import {
  formatContext,
  formatPricePerMtoken,
  formatSpeed,
  qualityLabel,
} from "@/components/marketplace/format";
import { fetchModelByHandleAndSlug } from "@/components/marketplace/queries";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase/public-config";

/**
 * The Open Graph card for one model.
 *
 * The site-wide card at `app/opengraph-image.tsx` is the right answer for every
 * page whose subject IS the site. A model page's subject is the model, and the
 * numbers a developer decides on — speed, context, price — are exactly what an
 * unfurl has room for. Sharing one link in a Slack channel is how most of these
 * pages will first be seen.
 *
 * SAME CONSTRAINTS AS THE SITE CARD, and they are not optional here either: no
 * `fonts` option, no `<img>`, no remote fetch, one font weight, hex colours
 * because Satori parses neither CSS custom properties nor `oklch()`. See that
 * file for the reasoning; this one only adds a database read.
 *
 * THE READ IS DELIBERATELY COOKIE-LESS. An unfurl bot has no session, so a
 * cookie-bound client would buy nothing and cost something: it would make the
 * card vary by viewer and opt the route out of any caching. `fetchModelByHandleAndSlug`
 * carries its own `visibility`/`status`/`deleted_at` predicates, so a private or
 * draft model resolves to `null` here exactly as it does on the page.
 */

export const alt = "Model on Nexus Inference";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BACKGROUND = "#121412";
const FOREGROUND = "#e6e8e6";
const MUTED = "#9ea39e";
const BORDER = "#333633";
const ACCENT = "#64ed7c";

type Params = { creator: string; slug: string };

/**
 * One `<span>` of the stat row. Satori has no `gap` inheritance worth relying on
 * and needs `display: flex` spelled out on anything holding more than a text
 * node, so the row is built from explicit pieces rather than a mapped fragment.
 */
function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 21, color: MUTED, letterSpacing: "0.04em" }}>{label}</span>
      <span style={{ fontSize: 34, color: FOREGROUND }}>{value}</span>
    </div>
  );
}

export default async function ModelOpengraphImage({ params }: { params: Promise<Params> }) {
  const { creator, slug } = await params;

  const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const model = await fetchModelByHandleAndSlug(
    supabase,
    decodeURIComponent(creator).toLowerCase(),
    decodeURIComponent(slug).toLowerCase(),
  );

  // A missing model still has to answer with an image: this route is fetched by
  // an unfurl bot, not by a browser that could follow a 404. The card falls back
  // to the id from the URL, which is all that is known — and the page itself
  // returns a real 404, so nothing here claims the model exists.
  const heading = model?.modelId ?? `${creator}/${slug}`;
  const subtitle = model?.displayName ?? "Model not found";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: BACKGROUND,
        color: FOREGROUND,
        borderTop: `10px solid ${ACCENT}`,
        padding: "68px 76px 72px 76px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", fontSize: 30 }}>
        <span style={{ letterSpacing: "-0.02em" }}>nexus</span>
        <span style={{ color: MUTED, fontSize: 24 }}>&nbsp;/ inference</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            // The id is the headline and it is user-supplied, so the size is
            // chosen for the long case rather than the pretty one: a 63-char
            // slug at 78px would overflow the card silently.
            fontSize: heading.length > 34 ? 54 : 68,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            maxWidth: 1000,
          }}
        >
          {heading}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 22,
            fontSize: 29,
            lineHeight: 1.3,
            color: MUTED,
            maxWidth: 940,
          }}
        >
          {subtitle}
        </div>
      </div>

      {model ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 56,
            paddingTop: 28,
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          <Stat label="SPEED" value={formatSpeed(model.measuredTokensPerSecond)} />
          <Stat label="CONTEXT" value={formatContext(model.contextLength)} />
          <Stat
            label="OUTPUT / 1M"
            value={formatPricePerMtoken(model.priceCompletionMicroPerMtoken)}
          />
          <Stat label="QUALITY" value={qualityLabel(model.qualityTier)} />
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            paddingTop: 28,
            borderTop: `1px solid ${BORDER}`,
            fontSize: 25,
            color: MUTED,
          }}
        >
          Open models on one OpenAI-compatible endpoint.
        </div>
      )}
    </div>,
    size,
  );
}
