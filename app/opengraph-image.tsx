import { ImageResponse } from "next/og";

/**
 * The site-wide Open Graph card (1200x630), rendered by Satori at build time.
 *
 * SELF-CONTAINED BY CONSTRUCTION. There is no `fonts` option, no `<img>`, no
 * `fetch`: the card is laid out entirely from text, borders and flat fills.
 * `next/og` bundles a Latin Noto Sans and uses it when nothing else matches, so
 * the render needs no network at all — which matters because an unfurl bot
 * gives up in about a second, and a font fetch that is slow or blocked does not
 * degrade to a plain card, it produces a broken one.
 *
 * That bundled face ships in ONE weight, so nothing here asks for a bold: the
 * hierarchy is carried by size, colour and tracking. Requesting 600 would
 * silently render at 400 and quietly flatten a design that assumed otherwise.
 *
 * COLOURS ARE HEX, not the `oklch()` tokens in `app/globals.css`. Satori has no
 * CSS custom properties and no oklch parser — it is not a browser — so these
 * are the dark-theme tokens converted once, by hand. If the theme moves, these
 * do not follow it automatically.
 */

const BACKGROUND = "#121412"; // --background, dark
const FOREGROUND = "#e6e8e6"; // --foreground, dark
const MUTED = "#9ea39e"; // --muted, dark
const BORDER = "#333633"; // --border, dark
const ACCENT = "#64ed7c"; // --accent, dark

export const alt = "Nexus Inference — serverless inference marketplace";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
        // The accent appears exactly once, as the rule across the top edge
        // (DESIGN.md §3.1). It is deliberately not on the wordmark.
        borderTop: `10px solid ${ACCENT}`,
        padding: "68px 76px 72px 76px",
        fontFamily: "sans-serif",
      }}
    >
      {/* The wordmark, matching components/wordmark.tsx: name in the
            foreground, path suffix held back in muted. */}
      <div style={{ display: "flex", alignItems: "baseline", fontSize: 34 }}>
        <span style={{ letterSpacing: "-0.02em" }}>nexus</span>
        <span style={{ color: MUTED, fontSize: 27 }}>&nbsp;/ inference</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: 78,
            lineHeight: 1.05,
            letterSpacing: "-0.035em",
            maxWidth: 880,
          }}
        >
          Serverless inference marketplace
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 26,
            fontSize: 31,
            lineHeight: 1.35,
            color: MUTED,
            maxWidth: 900,
          }}
        >
          Open models on one OpenAI-compatible endpoint. Per-token pricing, no hourly GPU bill.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          paddingTop: 26,
          borderTop: `1px solid ${BORDER}`,
          fontSize: 25,
          color: MUTED,
        }}
      >
        <span style={{ color: FOREGROUND }}>base_url + api_key</span>
        <span style={{ color: BORDER }}>·</span>
        <span>scales to zero</span>
        <span style={{ color: BORDER }}>·</span>
        <span>billed per token</span>
      </div>
    </div>,
    size,
  );
}
