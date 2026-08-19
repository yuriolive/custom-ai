# Design specification — visual language

> **Status:** normative for every UI surface in this repo.
> **Binding prerequisites:** `docs/PRD-inference-marketplace-mvp.md` §4.1.0 (HeroUI v3 constraints).
> Nothing here may be implemented in a way that violates §4.1.0. Where this document
> and §4.1.0 appear to disagree, §4.1.0 wins and this document is wrong.

The app works and looks like nothing. This document turns "make it look like Modal"
into values you can type into `app/globals.css` and utility classes you can put on
existing components, without opening modal.com again.

---

## 0. What was measured, and where it came from

Everything in §1–§3 is derived from the **public** CSS of the two reference sites,
read on 2026-08-18. No account, dashboard, or logged-in surface was reached from here.

§0.3 is different in kind: it is a **relay**. The owner reviewed their own logged-in
together.ai console and passed the observations through the coordinator. Those are
recorded as described, not as measured — there are no hex values in §0.3 because none
were sampled, and the one colour named there (`#E8674C`) is the owner's reading, not a
converted token. Treat §0.3 as competitive intelligence about *layout and information
architecture*, and §0.1–0.2 as the only source of colour and type values.

| Source | What was read |
|---|---|
| `modal.com` (marketing + blog + docs) | `_app/immutable/assets/0.Djf5vhhj.css` — the full design-token sheet, including both `[data-theme=light]` and `[data-theme=dark]` blocks, plus `Button.CRI-4v0v.css` |
| `www.together.ai`, `docs.together.ai` | `together-ai-…webflow.shared…min.css` and the docs shell |
| `node_modules/@heroui/styles/dist/themes/default/variables.css` | the token names our theme must actually override, and the derived tokens HeroUI computes for us |

### 0.1 Modal, concretely

Modal ships a two-tier token system: a `--color-raw-*` primitive ramp, and a
`--semantic-*` layer that is redefined per theme. Resolved:

**The green.** One hue family, and it *moves between themes* rather than staying put.

| Role | Dark | Light |
|---|---|---|
| accent fill (`background-accent-bold`) | `#7fee64` → `oklch(0.854 0.204 139.8)` | `#09af58` → `oklch(0.661 0.174 151.5)` |
| accent as text (`text-accent`) | `#6ac345` → `oklch(0.736 0.183 137.8)` | `#088644` → `oklch(0.544 0.141 152.1)` |
| accent tint (`background-accent`) | `#1d231c` (green-tinted near-black) | `#d8f9d9` |
| accent border | `#63cd93` / `#2d4327` | `#088644`-family |

The acid lime is a **dark-mode-only** colour. In light mode Modal drops ~19 points of
lightness and rotates ~12° toward emerald, because `#7fee64` on white is unreadable.
Any spec that ships one green for both themes is wrong, and that is the single most
important thing Modal's stylesheet tells you.

**Where the accent is used:** primary CTA fill, `text-accent` links inside prose and
docs, the active nav underline, "success/ready" status, the accent icon in alerts, and
the focus ring (as a `color-mix` at 80%). **Where it is not:** never as a card
background, never as a table row highlight, never as body text, never on more than one
element in a given card. Density of green on any Modal product screen is roughly one
element per viewport.

**The neutrals.** `--color-c-gray-*` / `--color-raw-gray-*` are **exactly chroma 0.0** —
pure grey, no hue bias at all, verified by converting each step (`#181818` →
`oklch(0.209 0.000 89.9)`). Modal's "warmth" comes from the green tints layered on top,
not from the ramp. Steps actually used:

| Semantic | Dark | Light |
|---|---|---|
| `background-ground` (page) | `#181818` | `#fafafa` |
| `background-elevated` (card) | `#222222` | `#ffffff` |
| `background-recessed` (well) | `#242424` | `#f2f2f2` |
| `background-floating` (popover) | `#272727` | `#ffffff` |
| `background-overlay` (modal) | `#1c1c1c` | `#ffffff` |
| `border-divider` | `#272727` | `#e8e8e8` |
| `border-primary` | `#464646` | `#bababa` |
| `text-primary` | `#d1d1d1` | `#464646` |
| `text-secondary` | `#bababa` | `#747474` |
| `text-tertiary` | `#747474` | `#8b8b8b` |

Two things to notice. The dark page ground is `#181818`, **not** `#000` — Modal never
bottoms out. And `text-primary` in dark is `#d1d1d1`, not white: body copy is
deliberately held back so the green and the white-adjacent headings have somewhere to go.

**Typography.** Two stacks, split by surface:

- **Marketing and blog only:** `Goga` — a licensed display grotesque, applied through
  `.marketing-h1…h5` and `.blog h1/h2`, always with `font-feature-settings: "ss01" on`,
  at weights 400 and 500 (never 600+), with `line-height` 1.0–1.3.
- **Product, docs body, buttons, everything functional:** `Inter Variable`, with
  `font-feature-settings: "cv11" on` (Inter's single-storey `a`), at 400/500 almost
  exclusively. `.btn` is `text-sm` / `font-weight-medium`.
- **Code and identifiers:** `Fira Mono`, 400 only. Docs code blocks are Shiki with a
  dual-theme setup (`--shiki-light` / `--shiki-dark` swapped by `[data-theme]`) and a
  transparent block background — the block inherits the recessed surface rather than
  painting its own.

Their type scale is stock Tailwind v4 (`--text-xs` .75rem … `--text-4xl` 2.25rem);
there is no custom scale. Headings do the work through *tracking and family*, not
through invented sizes.

**Geometry.** `--radius-md` (6px) on buttons, `.25rem` (4px) on small buttons, `sm/md/lg`
(4/6/8px) on nearly everything else. A handful of pill/circle exceptions. `--spacing`
is `.25rem` and every pad/gap is a multiple of it.

**Borders and shadows.** 1px, always. `box-shadow` is used for exactly two things:
focus rings (`0 0 0 3px` in a `color-mix(in oklch, <border> 80%, transparent)`) and a
`0 1px 3px` on a couple of light-mode floats. **Elevation in dark mode is carried
entirely by the background step plus a 1px border — there are no drop shadows.**

**Motion.** `.btn` transitions `color, background-color, border-color, outline-color`
only, `150ms`, `cubic-bezier(.4,0,.2,1)`. No `transform`, no `scale`, no `translate` on
hover anywhere in the component CSS. The longer durations in the sheet (`.3s`, `.5s`,
`.7s`) belong to marketing carousels and the particle-globe hero — i.e. to things we
are explicitly not building.

### 0.2 together.ai, concretely

Secondary reference, and it contributes almost nothing to colour: their brand is
**orange** `#fc4c02` (`oklch(0.662 0.221 36.9)`) with a cyan/blue/purple support
palette (`#70e9f0`, `#9bcdf5`, `#caaef5`) on a navy-biased near-black `#010120`
(`oklch(0.117 0.071 268.1)` — a genuinely hue-biased ground, unlike Modal's). Docs
carry the same orange as `--primary`.

What is worth taking from them:

1. **Tight radii.** Their two dominant values are 4px and 8px; nothing on a functional
   surface is rounder than 8px.
2. **Mono as a labelling device.** `PP Neue Montreal Mono` is used for eyebrows, stat
   labels, and table column heads — not only for code. Mono reads as "this is a value,
   not prose", which is exactly the distinction a metrics-dense catalog needs.
3. **A hue-biased dark ground.** `#010120` is unmistakably not-grey. Modal's is grey.
   We pick a third option (§1).

Their display faces (`The Future`, `PP Neue Montreal Mono`) are licensed and are not
available to us. Do not attempt to substitute lookalikes.

### 0.3 together.ai's console — relayed, not sampled

Source: the owner's own logged-in account, relayed via the coordinator. This is the
closest thing we have to a competitive baseline for the surfaces we ship, because it is
the same product shape rather than a marketing site.

**Their console accent is coral/salmon, roughly `#E8674C`** — active nav item, active tab
underline, slider fills, primary CTAs, inline links. This is load-bearing for us in one
specific way: it settles the accent question. The owner's directive is a green accent,
and the competitive rationale now matches the preference — green is the maximum available
separation from the nearest competitor's console while staying in the register a
developer tool is expected to occupy. **No coral, salmon, or orange is proposed as a
primary accent anywhere in this document, and none may be introduced later.** Orange
survives only as `--warning`, at a hue (62) far from coral (≈35).

Observed patterns, by surface:

| Surface | What they do |
|---|---|
| **App shell** | Persistent left sidebar ≈195px, dark, grouped sections under muted small-caps labels (`Inference`, `Model Shaping`), outline icons. Collapses to icons-only on the Playground to reclaim width. |
| **Catalog** | Featured cards row, 4 across, sitting *above* a filterable table. Left filter rail of checkbox groups (Visibility, Deployment, Input modalities). `All models` / `My models` tabs. Search field. Sortable columns. Per-row `⋮` menu. Row checkboxes driving a Compare action. |
| **Model card** | Name (large, semibold) → author with small logo → **capability chips** (`Chat`, `JSON Mode`, `Tool Calling`, `Multi-Modal`) as outline pills in a muted treatment → footer row carrying deployment mode and pricing. |
| **Pricing format** | `$3.00 / $15.00 (Cached Input: $0.30)` — input/output per 1M with cached input called out inline. |
| **Playground** | Chat in the centre, right rail of parameter controls (sliders with an `UNSET` pill, dropdowns, collapsible groups), a `Functions / + Add Function` block, an `API view` button. |
| **Empty / blocked state** | Centred card, icon inside a rounded tile, title, one-sentence explanation, one accent CTA. Their read-only banner is an amber Alert with an inline link. |
| **New fine-tuning job form** | `Choose a source` as a segmented tab row (`From base model` \| `From previous run` \| `From HF Hub`). Two-column fields, each label carrying a small ⓘ affordance. On the HF Hub tab: `Hugging Face Hub model source` (placeholder literally `organization/model`), `Base model` dropdown, `Model revision` (placeholder `main`), `Hugging Face API token` (placeholder `hf_...`, masked with a reveal toggle on the input's right edge). A **sticky right-hand `Summary` panel** with a title, a one-line explanation that doubles as its own empty state, a pricing link, and the primary CTA disabled until the form validates. |

**Three things this independently validates**, worth stating because it means our rules
are market-standard rather than idiosyncratic:

1. **No GPU names appear in their UI either.** Capability only. Our capability-not-hardware
   rule is the industry position, not a house eccentricity — which also means we lose
   nothing competitively by holding it.
2. **`Tool Calling` is a capability chip on the card.** It is table stakes at *discovery*
   time. Our `supports_tools` flag therefore belongs on the model card, not left for a
   caller to find out at request time when a tool call comes back unsupported.
3. **Serverless vs Dedicated is a first-class filter.** Same axis as our scale-to-zero vs
   always-warm tier, which tells us that surfacing the cold-start tradeoff as a *filter*
   rather than only as prose is the expected shape.

**One divergence we take deliberately.** They print parameter count on cards (`2.8T`,
`436.2B`, `29.8B`). **We do not, and the recommendation is to keep it off.** Parameter
count is a proxy the caller has to translate before it means anything, and translating it
is the job we claim to do: what a caller buys is throughput, context, quality and price,
all four of which we show directly. Printing `29.8B` beside `92 tok/s` invites the reader
to reason about size rather than trust the measured number — and if size ever *did*
predict our throughput better than our measurement of it, the measurement would be the
thing to fix. Quality label plus measured tok/s carries this. If a creator-side surface
needs the figure, it belongs in the Deployment Plan card (§3.11) where hardware facts
legitimately live, not on a discovery card.

---

## 1. Tokens

### 1.1 The decisions behind the numbers

- **The accent is green. This is settled, not proposed.** The owner's directive, and it
  has a competitive rationale on top of the preference: together.ai's console accent is
  coral (≈`#E8674C`, hue ≈35), so green is the largest available separation from the
  nearest competitor's console while staying in the register a developer tool occupies.
  No coral, salmon, or orange may be introduced as a primary accent — `--warning` at hue
  62 is the only warm colour in the system, and it exists to mean *caution*.
- **Accent hue 156, not 140.** Modal's dark lime is hue 139.8 at chroma 0.204 — an acid,
  slightly yellow green that is *theirs*. We sit at **hue 156** with chroma **0.175** in
  dark: unmistakably a bright signal green in the same neighbourhood, visibly cooler and
  less acid side by side. In light we hold the same hue and drop to
  `oklch(0.52 0.13 156)`, which clears 4.5:1 on both white and our page ground, and
  carries white text at 5.0:1.
- **Neutrals carry a slight green bias.** Chroma `0.003`–`0.010` at hue 156. This is a
  deliberate third path: Modal's ramp is pure grey (chroma 0.000), together's ground is
  strongly navy (chroma 0.071). Ours is *barely* green — enough that the greys sit in the
  same family as the accent and the dark ground reads as graphite rather than as the
  violet cast we ship today (the current tokens are hue 285.9, i.e. zinc), and little
  enough that nobody would call it a colour. Do not raise chroma above 0.012 on any
  neutral; past that it becomes a mint UI.
- **Success is teal, not green.** Modal collapses accent and success into one green
  family. We cannot: our model card already puts an accent Chip (measured tok/s) directly
  next to a status-coloured Chip, and two greens 2° apart in a chip row is unreadable.
  Success sits at **hue 178** — clearly teal-ward, 22° off the accent, at lower chroma.
- **Code tokens are their own set.** `highlight.ts` currently paints string literals with
  `text-success` and keywords with `text-accent`. Once the accent is green, those two are
  near-neighbours and the highlighting stops carrying information. Syntax colours get
  dedicated tokens that are *not* semantic status colours (§1.4).
- **Radius drops to `0.5rem`.** HeroUI derives its whole radius scale from `--radius`, so
  this single value gives `rounded-sm` 4px / `rounded-md` 6px / `rounded-lg` 8px /
  `rounded-xl` 12px — the Modal and together scale exactly. Today's `0.75rem` override
  also inflates `--field-radius` to 18px via HeroUI's `calc(--radius * 1.5)`, which is
  why inputs look like pills.

### 1.2 Core ramp

Every value is `oklch(L C H)`. Hex in the comment column is the sRGB rendering, for
eyeballing only — **the CSS must ship oklch**, per §4.1.0.

| Custom property | Light | Dark | Purpose |
|---|---|---|---|
| `--background` | `oklch(0.982 0.003 156)` `#f7faf8` | `oklch(0.19 0.005 156)` `#121413` | Page ground. Dark is above black on purpose. |
| `--foreground` | `oklch(0.24 0.008 156)` `#1c201e` | `oklch(0.93 0.004 156)` `#e6e9e7` | Body text. Dark is not white. |
| `--surface` | `oklch(1 0 0)` `#ffffff` | `oklch(0.23 0.005 156)` `#1b1e1c` | Cards, panels, code blocks. |
| `--surface-foreground` | `var(--foreground)` | `var(--foreground)` | |
| `--surface-secondary` | `oklch(0.965 0.004 156)` `#f1f4f2` | `oklch(0.265 0.006 156)` `#232624` | Table header row, tab strip, inset wells. |
| `--surface-tertiary` | `oklch(0.945 0.005 156)` `#eaeeeb` | `oklch(0.3 0.006 156)` `#2b2f2c` | Hovered row, pressed segment. |
| `--overlay` | `oklch(1 0 0)` `#ffffff` | `oklch(0.245 0.005 156)` `#1f211f` | Modal, popover, dropdown. One step *above* surface in dark. |
| `--overlay-foreground` | `var(--foreground)` | `var(--foreground)` | |
| `--muted` | `oklch(0.515 0.012 156)` `#626a65` | `oklch(0.71 0.01 156)` `#9da39f` | Secondary text. 5.30:1 / 7.20:1 on ground. |
| `--separator` | `oklch(0.925 0.005 156)` `#e4e7e5` | `oklch(0.28 0.006 156)` `#272a28` | Hairlines *inside* a surface (table rows, list dividers). |
| `--border` | `oklch(0.89 0.006 156)` `#d8dcd9` | `oklch(0.33 0.007 156)` `#333634` | The outline of a surface. |
| `--border-strong` | `oklch(0.79 0.008 156)` `#b7bcb8` | `oklch(0.43 0.008 156)` `#4c514e` | Custom token. Dashed empty-state frames, input outlines, anything where the border itself must be legible. |
| `--default` | `oklch(0.94 0.004 156)` `#e9ecea` | `oklch(0.29 0.006 156)` `#292c2a` | HeroUI's neutral *fill* (default Button/Chip). Not a border. |
| `--default-foreground` | `var(--foreground)` | `var(--foreground)` | |

### 1.3 Accent and status

| Custom property | Light | Dark | Notes |
|---|---|---|---|
| `--accent` | `oklch(0.52 0.13 156)` `#007e48` | `oklch(0.825 0.175 156)` `#49e694` | 4.90:1 on light ground, 11.48:1 on dark ground. |
| `--accent-foreground` | `oklch(0.9911 0 0)` `#fcfcfc` | `oklch(0.19 0.01 156)` `#101512` | 5.02:1 / 11.45:1 against the fill. |
| `--success` | `oklch(0.51 0.095 178)` `#007766` | `oklch(0.79 0.125 178)` `#49d5ba` | Teal-green. Status only. |
| `--success-foreground` | `oklch(0.9911 0 0)` | `oklch(0.19 0.01 156)` | |
| `--warning` | `oklch(0.77 0.15 62)` `#f79c40` | `oklch(0.81 0.136 62)` `#ffac5d` | **Light warning is a light fill with dark text** (7.68:1) — the Modal pattern. Never use `--warning` as light-mode text. |
| `--warning-foreground` | `var(--foreground)` | `oklch(0.19 0.01 156)` | |
| `--warning-text` | `oklch(0.52 0.12 62)` `#995600` | `oklch(0.81 0.136 62)` `#ffac5d` | Custom. The only token allowed for warning-coloured *text*. 5.70:1 / 9.96:1. |
| `--danger` | `oklch(0.56 0.2 22)` `#d02a3a` | `oklch(0.715 0.165 22)` `#f97373` | 4.91:1 / 6.81:1. |
| `--danger-foreground` | `oklch(0.9911 0 0)` | `oklch(0.19 0.01 156)` | |
| `--info` | `oklch(0.53 0.145 240)` `#0073b6` | `oklch(0.81 0.08 240)` `#91c8f0` | Custom. Neutral-informational alerts and the "how this works" notes that are currently `status="default"`. |
| `--info-foreground` | `oklch(0.9911 0 0)` | `oklch(0.19 0.01 156)` | |
| `--focus` | `var(--accent)` | `var(--accent)` | HeroUI default; keep. |
| `--link` | `var(--accent)` | `var(--accent)` | Changed from HeroUI's `var(--foreground)`. In-prose links are green, as on Modal docs. |

### 1.4 Syntax tokens

Dedicated, so syntax colouring never competes with status colouring. All checked against
`--surface`, which is what the code block sits on.

| Custom property | Light | Dark | Ratio (light / dark, on surface) |
|---|---|---|---|
| `--code-keyword` | `oklch(0.5 0.13 156)` `#007842` | `oklch(0.825 0.175 156)` `#49e694` | 5.58 / 10.43 |
| `--code-string` | `oklch(0.48 0.09 178)` `#006e5e` | `oklch(0.8 0.1 178)` `#6fd3be` | 6.19 / 9.40 |
| `--code-number` | `oklch(0.52 0.12 62)` `#995600` | `oklch(0.81 0.136 62)` `#ffac5d` | 5.70 / 9.06 |
| `--code-property` | `oklch(0.45 0.12 240)` `#005b90` | `oklch(0.85 0.07 240)` `#a4d5f7` | 7.24 / 10.76 |
| `--code-comment` | `oklch(0.56 0.01 156)` `#707672` | `oklch(0.62 0.008 156)` `#828884` | 4.64 / 4.65 |

`--code-keyword` intentionally equals `--accent` in each theme: the keyword is the
thing you want the eye to land on, and one shared value means the block reads as part
of the product rather than as an imported theme. Everything else diverges.

### 1.5 Geometry, elevation, motion

| Custom property | Value (both themes unless noted) |
|---|---|
| `--radius` | `0.5rem` — yields `xs` 2 / `sm` 4 / `md` 6 / `lg` 8 / `xl` 12 / `2xl` 16px |
| `--field-radius` | `0.375rem` (6px). Overridden explicitly; do **not** let HeroUI's `calc(--radius * 1.5)` stand. |
| `--border-width` | `1px` |
| `--ring-offset-width` | `2px` (HeroUI default; keep) |
| `--surface-shadow` | `0 0 0 0 transparent` in **both** themes. Cards get elevation from the background step and the 1px border, never from a shadow. |
| `--overlay-shadow` | light: `0 8px 24px -6px oklch(0.24 0.008 156 / 0.12), 0 2px 6px -2px oklch(0.24 0.008 156 / 0.08)`; dark: `0 0 0 1px oklch(1 0 0 / 0.06) inset` |
| `--field-shadow` | `0 0 0 0 transparent` (keeps ring utilities working) |
| `--motion-fast` | `120ms` |
| `--motion-base` | `180ms` |
| `--motion-ease` | `cubic-bezier(0.4, 0, 0.2, 1)` |

**Spacing rhythm.** 4px base (`--spacing: 0.25rem`, HeroUI's default). Permitted steps
only: `1 2 3 4 5 6 8 10 12 16 20 24`. Concretely:

| Context | Value |
|---|---|
| Card padding | `p-4` mobile, `p-5` from `sm:` |
| Chip row gap | `gap-2` |
| Grid gap (catalog, stat grids) | `gap-4` |
| Stack gap inside a panel | `gap-6` |
| Gap between console sections | `gap-8` |
| Gap between marketing sections | `gap-12` |
| Nav height | `h-14` (56px) — unchanged |
| Table cell padding | `px-4 py-3` |
| Page gutter | `px-4` mobile, `px-6` from `sm:` |

**Motion — the complete list of things allowed to move:**

1. `color`, `background-color`, `border-color`, `opacity` on hover/press/focus, at
   `--motion-fast`.
2. The streaming caret (`.streaming-caret`, already in `globals.css`). Keep as is.
3. HeroUI `Skeleton`'s shimmer, and only while data is genuinely in flight.
4. Modal/popover enter-exit, which HeroUI owns via CSS. Do not extend it.

Nothing else. **No `transform` on hover, ever** — no lift, no scale, no translate. No
gradient sweeps, no glow, no marquee, no scroll-linked animation, no count-up on
figures (a wallet balance that animates from 0 is a lie for 400ms). Everything in items
1–4 must be inert under `@media (prefers-reduced-motion: reduce)`, which the caret
already respects and the rest gets for free by being colour-only.

---

## 2. Typography

### 2.1 The faces

The CSP restriction that applies to published Artifacts does **not** apply here — this
is an ordinary Next.js app, so `next/font` is available and is the right tool: it
self-hosts the font files at build time, emits a `size-adjust` fallback so there is no
layout shift, and makes zero third-party requests at runtime.

```ts
// app/layout.tsx
import { Inter, JetBrains_Mono } from "next/font/google";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans-face",
  axes: [],            // wght only; we never need slnt or opsz
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-face",
  weight: ["400", "500"],
});
```

```html
<html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
```

```css
/* app/globals.css, after the two @imports */
@theme {
  --font-sans: var(--font-sans-face), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-mono-face), ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

**Inter for everything that is prose or UI.** It is the same face Modal uses on every
functional surface, it is SIL OFL (Modal's display face `Goga` and together's
`The Future` are both licensed and off-limits), it is variable so 400–700 is one file,
and its `tnum` figures are genuinely monospaced — which matters because the PRD demands
`tabular-nums` on every aligned column.

Set `font-feature-settings: "cv11"` on `body`. That is Inter's single-storey `a`, and it
is what Modal enables on `.btn` and body copy; it is the cheapest available half-step
away from default-Inter without buying a typeface.

**JetBrains Mono for code and identifiers**, with **ligatures off**:

```css
code, pre, .font-mono {
  font-variant-ligatures: none;
}
```

Adjacent to Modal's Fira Mono in weight and width, open-licensed, with a slashed zero
and unambiguous `1lI` / `0O` — which is the entire job when the thing on screen is an
API key or a model id someone is about to retype. Ligatures are off because a developer
copying `!=` out of a snippet should see the two characters that are actually there.

**No display face.** Headings are differentiated by size, weight 600, and negative
tracking, not by a second family. This is the one place we deliberately diverge from
Modal, and §4 explains why.

### 2.2 Scale

Sizes stay on Tailwind's stock scale wherever possible so utilities read normally;
tracking and line-height are the specified part. `tracking` values are `letter-spacing`.

| Role | Class recipe | Size / line-height | Weight | Tracking |
|---|---|---|---|---|
| `display` — marketing h1 only | `text-3xl sm:text-4xl font-semibold tracking-[-0.03em] leading-[1.1]` | 30 → 36px / 1.1 | 600 | −0.03em |
| `h1` — page title | `text-2xl font-semibold tracking-[-0.025em] leading-[1.2]` | 24px / 1.2 | 600 | −0.025em |
| `h2` — section | `text-xl font-semibold tracking-[-0.02em] leading-[1.25]` | 20px / 1.25 | 600 | −0.02em |
| `h3` — subsection | `text-base font-semibold tracking-[-0.015em] leading-[1.4]` | 16px / 1.4 | 600 | −0.015em |
| `card-title` | `text-sm font-semibold tracking-[-0.01em] leading-[1.4]` | 14px / 1.4 | 600 | −0.01em |
| `body` — console / dense | `text-sm leading-[1.55]` | 14px / 1.55 | 400 | 0 |
| `body-lg` — marketing prose | `text-base leading-[1.65]` | 16px / 1.65 | 400 | 0 |
| `label` — form labels, table heads | `text-xs font-medium leading-[1.3]` | 12px / 1.3 | 500 | 0 |
| `eyebrow` — stat labels, "Step 1" | `font-mono text-[0.6875rem] font-medium uppercase tracking-[0.08em]` | 11px | 500 | +0.08em |
| `micro` — hints, footnotes | `text-xs leading-[1.45]` | 12px / 1.45 | 400 | 0 |
| `figure` — a stat | `text-xl font-semibold tabular-nums tracking-[-0.02em]` | 20px | 600 | −0.02em |
| `figure-lg` — the balance | `text-3xl sm:text-4xl font-semibold tabular-nums tracking-[-0.03em]` | 30 → 36px | 600 | −0.03em |
| `code-inline` | `font-mono text-[0.8125rem]` | 13px | 400 | 0 |
| `code-block` | `font-mono text-[0.8125rem] leading-[1.65]` | 13px / 1.65 | 400 | 0 |
| `identifier` — `creator/slug`, key prefix | `font-mono text-sm` | 14px | 400 | 0 |

Weights in use: **400, 500, 600**. Nothing is 700, nothing is 300. Three weights is the
whole vocabulary — the same restraint Modal shows (400/500 on product, 400/500 on
marketing display).

`tabular-nums` is mandatory on: every `Table.Cell` containing a figure, every `Stat`
value, every price/speed/context Chip, the balance chip in the nav, pagination counts,
and token counts. It is already applied in `wallet-panel.tsx` and `primitives.tsx` —
extend it to the marketplace Chips, which currently lack it.

The `eyebrow` role is the one idea taken from together.ai: mono, uppercase, tracked out,
for the label above a number. It reads as instrumentation, which is what a metrics-dense
catalog wants, and it lets a stat label sit at 11px without looking like fine print.

---

## 3. Component direction

Every recipe below is expressed in HeroUI v3 terms. Compound composition, `onPress`,
`Alert status`, `Chip color` × `variant` — as §4.1.0 requires. Where a component already
exists, the note says what changes rather than restating the file.

### 3.0 App shell — the one new structural decision

Today every route sits in a single centred `max-w-6xl` column under a horizontal nav.
That is right for the public marketplace and wrong for the authenticated product, where
together.ai's shape is the correct one and we should meet it:

- **Public routes** (`/`, `/models/[creator]/[slug]`, `/login`, `/signup`) keep the
  horizontal top nav and the centred column. A catalog is a document; it should read like
  one, and it must stay server-rendered and indexable (FR-MKT-006).
- **Authenticated routes** (`/console/*`, Creator Studio, `/playground`) move to a
  **persistent left sidebar**: `w-52` (208px — a hair wider than their 195px, because our
  labels are longer), `bg-surface`, one `border-r border-border`, full height, with the
  top nav reduced to the wordmark, balance chip, theme toggle and user menu.
  - Sections grouped under `eyebrow`-role labels (§2.2): mono, uppercase, tracked,
    `text-muted`. `Console` / `Studio` / `Playground`.
  - Items: `text-sm text-muted hover:text-foreground hover:bg-surface-secondary
    rounded-md px-3 py-2`. Active item gets `bg-surface-secondary text-foreground
    font-medium` plus a 2px `bg-accent` left rule. Not a filled accent pill — one green
    element per viewport still holds.
  - Icons are optional and, if used, 16px outline only. If a label is clear without one,
    ship it without one.
  - **On `/playground` the sidebar collapses to icons-only (`w-14`)**, which is their
    pattern and is right: the playground needs the width for the transcript and the
    parameter rail.
  - Below `lg:` the sidebar is not on screen. It becomes a `Modal`-based drawer behind a
    hamburger, and the console's existing horizontal `ConsoleNav` (§3.1) stays as the
    mobile navigation. Two nav mechanisms is acceptable here; a 208px sidebar at 375px is
    not.
- This is the largest change in the document and it is scheduled last (§5, step 8),
  after everything else is correct, because it is the only change that can break every
  authenticated page at once.

### 3.1 Nav (`components/site-nav.tsx`, `components/console/console-nav.tsx`)

Root nav keeps its shape: `h-14`, sticky, `bg-background/85 backdrop-blur`, one 1px
bottom border. Changes:

- `border-b border-default` → **`border-b border-border`**. `--default` is HeroUI's
  neutral *fill*; using it as a border colour is why the line currently reads as a
  smudge rather than a rule.
- Wordmark: `nexus` at `font-semibold tracking-[-0.02em]`, ` / inference` at
  `font-normal text-muted`. Set the slash-and-suffix in `font-mono text-sm` — the
  product name is a path, so render it as one. Do not colour any part of the wordmark
  green; the accent is spent elsewhere.
- Destination links: `text-sm text-muted hover:text-foreground`, transition
  `colors 120ms`. Active destination gets `text-foreground font-medium` — no pill, no
  background.
- `BalanceChip`: `color="accent" variant="soft"` while funded, `color="danger"` at zero.
  Add `tabular-nums` to the label so the figure does not shimmer on update. Keep the
  `(placeholder)` suffix until it is real.
- Console sub-nav keeps the underline-tab pattern (it is the correct one and it matches
  Modal's docs nav): `border-b-2 border-transparent` → `border-accent` when active,
  `text-muted` → `text-foreground font-medium`. Swap the container's `border-default`
  for `border-border` here too. The `overflow-x-auto` on the `<ul>` is what keeps 375px
  from overflowing — **do not** replace it with `flex-wrap`.

### 3.2 Model card (`components/marketplace/model-card.tsx`)

The card is structurally right — one keyboard stop, stretched-anchor title, footer in a
`relative z-10` layer. What changes is entirely visual, plus one semantic fix.

- **Container.** `Card` with `bg-surface border border-border rounded-lg`, no shadow.
  Hover changes `border-color` to `--border-strong` and `background-color` to
  `--surface-secondary`. **Remove `hover:shadow-md`** — it is the one thing on the page
  that contradicts the whole elevation model.
- **Title.** Stays `font-mono break-all` at `card-title` size. This is the strongest
  Modal-adjacent move available to us: the primary identifier on a card is code, so it
  is set in code.
- **Chip row — the semantic fix.** Today three of the five chips are status-coloured, and
  `qualityChipColor` returns `"success"` for `maximum`/`full`, which puts a green chip
  immediately beside the green accent speed chip. Retarget:

  | Chip | `color` | `variant` | Why |
  |---|---|---|---|
  | measured tok/s | `accent` | `soft` | The one accent per card. This is the number the product is selling, and it is measured (FR-DEP-052) — never predicted. |
  | context window | `default` | `soft` | A capability, not a judgement. |
  | quality tier | `default` | `soft` | **Changed from `success`/`warning`.** Quality is an attribute of the artifact, not a health status. Encode it in the *label*, set in `font-mono`. |
  | price in / price out | `default` | `secondary` | Money is neutral. Add `tabular-nums`. |
  | live status (FR-MKT-009) | `success` \| `warning` \| `danger` | `soft` | The **only** place status colour is allowed on this card. |

  That leaves exactly one green chip and, at most, one status chip per card — the density
  Modal maintains.
- **Capability chips — a second, visually distinct row.** together.ai puts `Chat`,
  `JSON Mode`, `Tool Calling`, `Multi-Modal` on the card as outline pills, and that is
  table stakes: whether a model supports tool calling decides whether a caller can use it
  at all, and finding out at request time from an unsupported-tool error is a bad first
  experience. Render `supports_tools` (and streaming/JSON-mode flags as they land) as
  `Chip color="default" variant="tertiary"` — an **outline** pill, `size="sm"`, label in
  `font-mono text-[0.6875rem] uppercase tracking-[0.04em]`. Put them on their own row
  *below* the metric chips with `gap-1.5`, so the card reads top-to-bottom as
  identity → measured numbers → capabilities → price. Outline-versus-soft is what keeps
  eight chips from becoming visual noise: the soft row is *how it performs*, the outline
  row is *what it accepts*.
- **Chip typography.** Numeric chips get `font-mono tabular-nums`; the quality label gets
  `font-mono`. `size="sm"`.
- **Pricing format.** Adopt their compact form rather than two separate chips once there
  is a third price component: `$0.30 / $1.20 per 1M` in a single chip, `tabular-nums`,
  with any cached-input rate inline in parentheses (`(cached in $0.03)`) exactly as they
  do. Until a cached rate exists, the current two chips are fine — but the slash form is
  the target, because it is one element instead of two for information a caller reads as
  one pair.
- **Deployment tier.** Their card footer carries deployment mode, and the equivalent axis
  for us is scale-to-zero versus always-warm. Show it as one `Chip color="default"
  variant="tertiary"`, labelled in capability terms (`scales to zero` / `always warm`) —
  never in infrastructure terms. It is also a filter (§3.3).
- **Footer.** `Code` stays `<Button variant="secondary" size="sm">`. `Try it →` stays a
  real `<Link>` (HeroUI's `Button` is a React Aria `<button>` and takes no `href`) but
  its class becomes `rounded-[var(--field-radius)]` instead of
  `rounded-[calc(var(--radius)/1.5)]` — stop re-deriving what HeroUI already exposes.
- **No GPU, no hardware, ever.** `CatalogModel` has no field that could leak one; keep it
  that way. If a future chip is tempting, the test is: would a developer change their
  code because of it? tok/s and context pass. Silicon does not.

### 3.3 Catalog grid and controls

- Grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4`. The 4-column
  breakpoint is in FR-MKT-001 and needs the page container widened to `max-w-[88rem]`
  on the catalog route only — the console stays `max-w-6xl`. Do this last (§5, step 7);
  it is the only change that touches page layout.
- Filter rail: `Select` triggers and the `SearchField` all at `size="sm"`, on
  `--field-background` with a `--border` outline at `--field-radius`. Active filters
  render as removable `Chip color="accent" variant="soft"` so the URL state is visible —
  the rail is the one place a second accent element per viewport is justified, because it
  is reporting *your* input rather than decorating.
- `CatalogSkeleton` must match the real card's height and chip-row geometry exactly.
  A skeleton whose height differs from its replacement is a layout shift with extra steps.

**Where we follow their catalog, and where we do not.** together.ai runs a *featured cards
row above a filterable table*, with checkbox filter groups, `All models` / `My models`
tabs, sortable columns, a per-row `⋮` menu, and row checkboxes for Compare.

- **Take the filter-group shape.** Our rail is already capability-based (speed, context,
  quality, price, creator) and URL-backed, which is better than their checkbox rail in one
  respect — ours is shareable. Keep the URL as the state. What is worth taking is the
  *grouping with a label per group*, in the `eyebrow` role, so the rail reads as five
  named axes instead of five loose controls.
- **Add the deployment-tier filter.** Scale-to-zero versus always-warm is the same
  first-class axis as their Serverless/Dedicated, and it is the single most consequential
  thing about calling our platform (a two-minute first token). Surfacing it as a filter
  rather than only as prose in `HomeIntro` is the expected shape and is a genuine
  usability gain. Labelled in capability terms; the word for the hardware state is
  *warm*, not the name of the thing that is warm.
- **Do not add the table view yet.** A cards-plus-table catalog is the right end state at
  a few hundred models. At MVP-0 scale a second view of the same rows is two skeletons,
  two empty states and two sort implementations to keep honest, for a catalog that fits on
  one screen. Revisit when the catalog exceeds roughly 50 rows; the trigger is real, so
  write it down rather than guessing later.
- **Do not add Compare, row checkboxes, or a `⋮` menu on public cards.** Compare is
  meaningful when models differ along eight axes; ours differ along four, all of which are
  already visible side by side in the grid. A `⋮` on a public card has nothing to put in
  it — the two actions (`Code`, `Try it`) are both primary and both already visible.
  A `⋮` menu *does* belong on the creator's own `My Models` rows (FR-STU-009), which is
  where the actions are numerous and destructive.
- **`All models` / `My models` tabs** belong in Creator Studio, not on the public catalog.
  The public catalog has exactly one audience state and adding a tab that is empty for
  every signed-out visitor costs more than it returns.

### 3.4 Code-snippet tabs (`snippet-tabs.tsx`, `code-block.tsx`)

The most important surface in the product. Target treatment:

- **Tab strip.** `Tabs.List` on `--surface-secondary`, `rounded-md`, `p-1`. Inactive tab
  `text-muted`, active tab `bg-surface text-foreground` — HeroUI drives this through
  `Tabs.Indicator`, which must stay inside `Tabs.Tab`. Tab labels in `font-mono text-xs`:
  `Python` / `TypeScript` / `cURL` are language names, so they are code.
- **Block.** `bg-surface` (light) — in dark, follow Modal and let the block sit on
  `--surface-secondary` with a 1px `--border`, `rounded-lg`, `p-4 pt-12`,
  `overflow-x-auto`, `tabIndex={0}` (already there, and required — a keyboard user must
  be able to scroll a long line). Replace `border-muted/25` with `border-border`;
  `--muted` is a text token and 25% of it is a guess, not a value.
- **Syntax.** Repoint `tokenClassName` at the §1.4 tokens: `text-[var(--code-comment)]
  italic`, `text-[var(--code-string)]`, `text-[var(--code-keyword)] font-medium`,
  `text-[var(--code-number)]`, `text-[var(--code-property)] font-medium`. Keep the
  hand-rolled tokenizer — the reasoning in `highlight.ts` is sound, and Modal's Shiki
  setup is only justified by their docs volume.
- **Copy button.** Stays top-right, `size="sm"`, `variant="secondary"` → `"primary"`
  while confirmed, with the existing `aria-live` status node. Two upgrades: on confirm,
  swap the label to `Copied` *and* tint the button with the accent (`variant="primary"`
  already does this once the accent is green, which is the payoff — the copy
  confirmation becomes the product's colour). Keep the visible failure path; a denied
  clipboard must never look like success.
- The `<dl>` of model-id / base-URL / timeout notes below the tabs: labels in `eyebrow`,
  values in `code-inline` at `text-foreground`, prose in `micro text-muted`. The
  cold-start paragraph stays where it is — above the fold, not in a comment.

### 3.5 Console tables (`wallet-panel.tsx`, `usage-panel.tsx`, `keys-panel.tsx`)

- `Table.ScrollContainer` wrapped in `rounded-lg border border-border overflow-hidden`.
  No shadow.
- `Table.Header` row on `--surface-secondary`; column labels in `label` role
  (`text-xs font-medium`), `text-muted`, and **uppercase mono for numeric columns** so
  the head telegraphs the column type.
- `Table.Row` separated by `divide-y divide-separator` — note `separator`, not `default`.
  Hover `bg-surface-tertiary`, `120ms`.
- Numeric cells: `text-end tabular-nums`, already correct in `wallet-panel.tsx`. Extend
  to every numeric column in the other two panels.
- Timestamps: `whitespace-nowrap tabular-nums font-mono text-xs`.
- Money: sign carries meaning, so keep `amountClass` — credits `text-success`, debits
  `text-foreground`, zero `text-muted`. With success now teal, a credit no longer looks
  like an accent element.
- Status chips (`UsageStatusChip`, `KeyStatusChip`): `variant="soft"`, `size="sm"`, label
  in `font-mono lowercase`. These are the legitimate home of status colour.
- `Load more` stays `<Button variant="outline">`. Below-table counts in `micro text-muted
  tabular-nums`.
- At 375px the `Table.ScrollContainer` scrolls; nothing is allowed to force the document
  to scroll horizontally. That is a hard constraint, and it is the reason columns are
  not made narrower to fit.

### 3.6 Wallet / balance display

- Balance uses the `figure-lg` role in a `Card` whose `Card.Content` is a
  `grid gap-6 sm:grid-cols-2`. `Stat`'s label already uses uppercase tracking — move it
  to the `eyebrow` role (mono) and it lands.
- The balance figure itself is `text-foreground`, **not** green. Green on a currency
  figure reads as "up" and this number does not have a direction. The accent's job here
  is the nav chip, which signals *funded*, and the `Add funds` CTA when it exists.
- Keep the honest disabled `Add funds — unavailable` button and its explanation verbatim.
  A disabled control next to its reason is the correct pattern; make sure
  `--disabled-opacity: 0.5` still reads as disabled against the green fill (it does:
  `#49e694` at 50% on `#1b1e1c` drops well below the enabled state).
- The "Why a debit can differ from a hold" alert moves from `status="default"` to
  `status="default"` still — but style `default` alerts on `--surface-secondary` with a
  1px `--border`, and reserve `--info` for alerts that are genuinely telling you
  something you must act on. (`Alert` takes **`status`**, never `variant` or `color`.)

### 3.7 Auth forms

- `Card` at `max-w-sm mx-auto`, `bg-surface border border-border rounded-lg p-6`.
- `TextField` composition unchanged (`Label` › `Input` › `Description` › `FieldError`).
  Fields sit on `--field-background` with a `--border` outline at `--field-radius` (6px),
  focus adds the 2px accent ring at 2px offset. `Label` in the `label` role.
- Order stays GitHub-first: `GitHubButton` as `variant="secondary"` full-width, then a
  `Separator` with an `or` label, then email/password with the submit as
  `variant="primary"` — the one accent element on the page. **First in order is not the
  same as first in weight.** The code shipped this inverted for a while (GitHub filled,
  submit outlined), which left the email form looking disabled beside it; corrected.
- `FieldError` and `AuthAlert` in `--danger`. Error text at `micro`, never truncated.
- **Do not put a marketing hero, gradient, illustration, or proof panel beside the
  form. A sign-in page for a developer product is a form on a ground.**

  This rule was reversed during the 2026-08-18 redesign, a two-panel layout shipped to
  a preview, and the owner removed it on sight. Reinstated — and the failure is worth
  keeping, because the panel read fine in a plan and badly on a screen. The root layout
  renders a nav above the auth pages, so a full-height panel could not reach the top of
  the viewport and became a floating slab; its content is centred and short, so the top
  third was a large blank field of `--surface`; and it competed for attention on a page
  with exactly one job. Second time argued, second time it lost. The wordmark above the
  card is the one thing worth keeping from that attempt.

### 3.8 Empty states (`catalog-grid.tsx`, `primitives.tsx`)

The two-state distinction already in `CatalogEmpty` (nothing published vs nothing
matched) is correct and must survive. Visual treatment:

- **Frame:** `rounded-lg border border-dashed border-border-strong bg-transparent`,
  `px-6 py-14`, centred. Dashed is the signal that the container is empty rather than
  broken. `EmptyPanel` in `primitives.tsx` already does this — swap its
  `border-default` for `border-border-strong`.
- **Copy:** title at `h3`, body at `body text-muted max-w-md`, one action.
- **Action:** exactly one, and it is the next useful step, not "retry". "Nothing
  published" → `Create an account to deploy one` as an accent-filled `<Link>` styled to
  match a primary Button. "Nothing matched" → `Clear everything and show all models` as
  a plain `text-accent` link, because the user's own filters caused this and the fix is
  cheap.
- **One icon, in a tile.** together.ai's empty and blocked states are: centred card, icon
  inside a rounded tile, title, one-sentence explanation, one accent CTA. That is worth
  adopting exactly, because the tile is what makes a single small icon read as
  intentional rather than stranded. Spec: a `size-9` tile, `rounded-md
  bg-surface-secondary border border-border`, holding a 20px outline icon at
  `text-muted`. The icon is never accent-coloured — the CTA is the only green element.
- No illustration beyond that tile. No icon larger than 20px. An empty table is not an
  occasion.
- **The blocked/read-only variant.** Their read-only banner is an amber Alert with an
  inline link, and we need exactly that shape twice: the wallet's "self-service funding is
  not built in this release" and any future read-only mode. Spec: `Alert status="warning"`
  with `Alert.Indicator`, `Alert.Title`, `Alert.Description`, and the link inside the
  Description as `text-[var(--warning-text)] underline` — not as a Button, because the
  banner is informational and a button in it would compete with the page's real CTA.
  Remember `Alert` takes **`status`**; `Alert.Title` and `Alert.Description` must sit
  inside `Alert.Content`, and nothing that renders a block element may go inside
  `Alert.Description` (it is a `<p>`).
- `TableSkeleton` / `StatsSkeleton` keep their exact row geometry and swap
  `border-default divide-default` → `border-border divide-separator`.

### 3.9 The sticky-summary primitive

together.ai's fine-tuning form pairs a two-column field area with a **sticky right-hand
`Summary` panel** carrying a title, a one-line explanation that doubles as its own empty
state, a pricing link, and the primary CTA disabled until the form validates. Three
surfaces of ours want exactly this, so it is specified once as a reusable shape rather
than three times as a coincidence:

1. Creator Studio's Deployment Plan (§3.11, FR-STU-004b) — **the P0 case**.
2. The future fine-tuning form (PRD §4.7, Phase 3).
3. The wallet top-up flow, whenever a payment processor is wired up.

**Layout.** `grid gap-6 lg:grid-cols-[1fr_22rem]`. The panel is `lg:sticky lg:top-20
lg:self-start` (top offset clears the 56px nav plus a gap), `bg-surface border
border-border rounded-lg p-5`, `flex flex-col gap-4`. Below `lg:` it is not sticky and
it moves **below** the form — a sticky panel at 375px eats the viewport, and the CTA is
reachable by scrolling to the end of the form, which is where a person expects it.

**Contents, in order.**

| Slot | Treatment |
|---|---|
| Title | `h3` role. Names the thing, not the panel: `Deployment plan`, not `Summary`. |
| Body | Either the resolved content, or the empty-state sentence. Never both, never a spinner where the sentence should be. `body text-muted`. |
| Detail | Optional. A borderless two-column definition list (`grid grid-cols-[1fr_auto] gap-x-4 gap-y-2`), labels `label text-muted`, values `text-sm tabular-nums font-mono text-end`. Wide enough for six rows; past that use a real `Table`. |
| Disclosure | Optional `Disclosure` for rationale. Collapsed by default. Trigger in `text-sm text-accent`. |
| Reference link | `micro text-accent` — the "see pricing" slot. |
| CTA | One `Button variant="primary" fullWidth`, `isDisabled` until valid. |

**The rule that makes this pattern work:** the empty state and the resolved state occupy
the same slot and are the same shape, so the panel does not resize when the form becomes
valid. Write the empty sentence to be the same length as the resolved summary's first
line, and reserve the detail list's height rather than letting it grow in. A summary panel
that jumps as the user types is worse than no summary panel.

**Disabled CTA discipline.** `isDisabled` is only honest if the reason is visible. The
disabled CTA always has the blocking reason directly above or below it, in `micro
text-muted` — or, when the block is a real failure rather than incompleteness, in an
`Alert status="danger"`. This is the same principle already applied correctly to the
wallet's `Add funds — unavailable` button (§3.6): a control that cannot be pressed, next
to the reason it cannot.

### 3.10 Playground (`components/playground/`)

- **Shell.** Icons-only sidebar (§3.0) plus `grid gap-6 lg:grid-cols-[1fr_18rem]` —
  transcript left, parameter rail right. This is together.ai's shape and it is right; the
  PRD's own sketch (§4.1 playground snippet) already uses
  `lg:grid-cols-[1fr_280px]`, so this is a confirmation, not a change.
- **Parameter rail.** `Slider` composition per §4.1.0 (`Label` › `Slider.Output` ›
  `Slider.Track` › `Slider.Fill` + `Slider.Thumb`). Labels in `label` role, outputs in
  `font-mono tabular-nums text-xs`. `Slider.Fill` is the accent — this is a legitimate
  second accent element because it is reporting the user's own input, the same exemption
  the filter rail gets (§3.3).
- **Their `UNSET` pill is worth taking.** A slider that shows a value the request will not
  actually send is a lie. Where a parameter is genuinely unset and the upstream default
  applies, show `Chip color="default" variant="tertiary" size="sm"` reading `default`
  (lowercase mono) beside the label, and dim the `Slider.Fill` to
  `--accent-soft`. Pressing the slider commits the value and clears the pill.
- **Group collapsibles.** Advanced parameters go in a `Disclosure`, collapsed. Not tabs —
  the rail is one column and a tab strip in 18rem is cramped.
- **`API view`.** Take this. A button that shows the exact request the playground is about
  to send, in the same `CodeBlock` used by `SnippetTabs`, is the highest-value thing on the
  page for a developer — it converts a UI session into working code. `Button
  variant="secondary" size="sm"` in the transcript header, opening a `Modal` whose body is
  a single `CodeBlock` with the copy button.
- **Functions / tool-calling block.** Once `supports_tools` is on the card (§3.2), the
  playground needs somewhere to exercise it. Their `Functions` + `+ Add Function` block is
  the pattern: a labelled region, zero-state sentence, and one `variant="tertiary"` add
  button. Only render it when the selected model reports tool support — a control for a
  capability the model lacks is worse than its absence.
- **Cold-start notice.** Already correct in `cold-start-notice.tsx`: `Alert
  status="warning"` with an indeterminate `ProgressBar` as a **sibling** of
  `Alert.Description`, never a child (§4.1.0 — `Alert.Description` renders a `<p>`). Do
  not restyle it into something quieter; the two-minute first token is the product's
  central tradeoff and this is where it is honoured.
- **Streaming caret** stays exactly as it is in `globals.css`, including the
  reduced-motion branch.

### 3.11 Creator Studio (PRD §4.1.2 — does not exist yet)

The top P0 surface, and the one where the coordinator's relay is most directly usable:
together.ai's new-fine-tuning-job form is nearly field-for-field our deploy form — HF
slug, revision, masked token, sticky summary. **The form shape is market-standard; do not
reinvent it.**

**Layout.** The §3.9 primitive: `grid gap-6 lg:grid-cols-[1fr_22rem]`, fields left,
Deployment Plan sticky right.

**Fields.** Two-column within the form area (`grid gap-5 sm:grid-cols-2`), single column
below `sm:`. Each `Label` carries a small ⓘ affordance — a 14px icon button opening a
HeroUI `Tooltip`, `text-muted`, never a bare `title` attribute, because a tooltip that
only exists on hover is unreachable by keyboard and invisible on touch.

| Field | Composition | Placeholder / note |
|---|---|---|
| HF repo slug | `TextField` › `Label` › `Input` | Placeholder `organization/model`, literally. Theirs uses this exact string and it is unimprovable. `font-mono`. |
| Model revision | `TextField` | Placeholder `main`. `font-mono`. |
| Display name, description | `TextField`, `TextArea` | `TextArea` is a primitive `<textarea>` — **no `minRows`/`maxRows`**; auto-grow is a manual `scrollHeight` layout effect (§4.1.0). |
| HF token | `TextField` › `Label` › `InputGroup` › `InputGroup.Input` + `InputGroup.Suffix` › reveal `ToggleButton` | Placeholder `hf_...`. Masked. **Conditional — see below.** |
| Context window, minimum speed | `Slider` ×2 | Outputs in `font-mono tabular-nums`. Context capped at `max_position_embeddings` (FR-STU-004c). |
| Prices | `NumberField` ×2 | step 0.01, min 0, `tabular-nums`. |
| Visibility | `Switch` › **`Switch.Content` › (`Switch.Control` › `Switch.Thumb`) + `Label`**, with `Description` as a SIBLING of `Switch.Content` | `Switch.Content` is React Aria's `SwitchButton` — it renders the hidden `<input>` and owns the press target, so the track and thumb go **inside** it. Nesting them outside paints correctly (the root carries `data-selected`, so the thumb still slides) but makes the track dead to a click, which reads as a switch stuck on. `Description` inside `Switch.Content` puts a `<p>` in a `<label>`, so clicking the prose toggles the model's visibility. *(This row was wrong in the first revision of this document and shipped that way; corrected against `@heroui/styles`' own source note.)* |

**Our HF token field is conditional, and theirs is not — keep ours.** Theirs is always
visible on the HF Hub tab. Ours appears only when the repo probe reports private or gated
(FR-STU-003), which is better: most creators never see a credential field they do not
need. The cost is that a field appears mid-form, so it needs a designed arrival rather
than a layout jump:

- Reserve nothing. Instead, the field animates in with `grid-template-rows: 0fr → 1fr`
  plus `opacity` at `--motion-base`, which is a height transition that needs no measured
  pixel value. This is the **one** exception to "no layout animation" in §1.5, and it is
  justified because the alternative — content below jumping 76px — is worse. It must be
  inert under `prefers-reduced-motion` (the field simply appears).
- The probe result that triggers it renders as an inline `Alert`, not a Toast
  (FR-STU-002). The Alert says *why* the field appeared: "This repo is gated. A token with
  access is required." A field that materialises without explanation reads as a bug.

**Deployment Plan card — the §3.9 panel, carrying more than a number.** Theirs shows a
cost estimate; ours shows resolved GPU, predicted tok/s, max concurrent streams, a VRAM
breakdown, and a cost floor (FR-STU-004b). So the panel is designed for a small table plus
a collapsible, not for one figure:

- Detail list per §3.9, six rows: quality variant · predicted tok/s · max concurrent
  streams · weights GB · KV-cache GB · cost floor per 1M. All `tabular-nums`.
- The VRAM breakdown is three rows of a single figure each, not a chart. A three-segment
  bar chart of three numbers is decoration.
- `Disclosure` labelled `Why this GPU?` (FR-STU-004b's own wording), collapsed by default,
  containing the solver's rationale in prose.
- **Infeasibility state (FR-STU-004d) has no equivalent in their form and is ours to
  design.** When no variant is feasible, the panel's body slot is replaced by `Alert
  status="danger"` naming the specific blocking quantity **with its value** — "A 128k
  context needs 41 GB of KV cache; the largest feasible allocation is 22 GB" — followed by
  the offered remedies as a list of `Button variant="tertiary" size="sm"` that each apply
  the remedy to the form. A remedy the user has to translate into a slider movement
  themselves is only half a remedy. The CTA is disabled in this state and the Alert *is*
  the reason, so no additional hint line is needed.
- Submit is blocked only when no variant is feasible (FR-STU-004d). A price below the cost
  floor warns and does not block (FR-STU-005) — creators may subsidise deliberately, and a
  blocked submit would be us overruling a business decision that is theirs.

**`Choose a source` segmented row.** Take the pattern, `Tabs` composition per §4.1.0, but
do not build tabs that have one option. MVP-0 has exactly one source (HF Hub), so ship the
form without a tab strip and add it when `From previous run` exists (Phase 3, §4.7). A
one-tab tab strip is a promise the product has not made.

**Variant picker is a consequence table, not a Select (FR-STU-004a).** `Table` composition,
one row per discovered variant: quality label · size · predicted tok/s · max context ·
cost floor. Infeasible rows are visibly disabled (`opacity-50`) and carry their specific
blocking reason in the row, not in a tooltip. Raw quant tags (`Q4_K_M`) appear as
secondary text in `font-mono text-xs text-muted`, never as the row's primary label.

**Hardware appears here and nowhere else.** This is the boundary, and it needs stating
precisely because §4 item 8 is otherwise absolute: the PRD confines hardware to a
**read-only result inside the Deployment Plan card** (FR-STU-004, FR-STU-004b). It is
never an input — there is no GPU selector (FR-STU-001, FR-STU-004) — and it never crosses
into a consumer surface: not the catalog, not the model card, not the model detail page,
not the playground, not the console. A creator sees which silicon the solver resolved
because they are accountable for the cost floor it implies. A caller never does, because
it would not change a line of their code.

**`My Models` table (FR-STU-009).** §3.5 table treatment. This is where the per-row `⋮`
`Dropdown` belongs (Edit pricing · Toggle visibility · Playground · Delete) — numerous,
partly destructive actions on rows the user owns. Delete opens an `AlertDialog` requiring
the slug to be typed (FR-STU-010). The `All models` / `My models` tab pair also belongs
here rather than on the public catalog.

---

## 4. What not to copy, and why

This section is normative. Each item is a thing that exists on modal.com or
together.ai, is good there, and must not appear here.

**1. Modal's display typeface (`Goga`) and together's (`The Future`, `PP Neue Montreal
Mono`).** All licensed. Not available to us, and lookalike substitution is worse than
not trying — a near-miss grotesque reads as a knock-off in a way that plain Inter never
does. We get our heading character from tracking and weight (§2.2). This is also why our
type has one family where Modal has two: a single well-set face beats a second face
chosen for resemblance.

**2. The exact green `#7fee64`.** It is the most recognisable thing about Modal's brand.
Ours is hue 156 at lower chroma and, unlike theirs, holds one hue across both themes.
Adjacent, not identical, and identifiably a decision rather than an eyedropper.

**3. Every marketing animation.** The particle globe, the carousels, the
`HorizontalAutoScroll` band, the scroll-linked hero — all of these live in
Modal's *marketing* bundle, and Modal does not put them in its product either. A
developer console is a tool someone opens forty times a day to check a balance and copy
a key; motion in that context is friction with a bill attached. §1.5 lists the four
things allowed to move and that list is exhaustive.

**4. Illustration and iconographic decoration.** No spot illustrations, no isometric
diagrams, no decorative glyphs on empty states or cards. Icons exist only where they
carry meaning that text cannot (`Alert.Indicator`, `Modal.CloseTrigger`, the copy
affordance) and are capped at 20px.

**5. Modal's information architecture and page furniture.** Their pricing page layout,
their docs sidebar structure, their card-grid rhythm, their nav groupings — none of it
is ours to reuse. We render pricing per-token inside a model card, not in a plan-tier
comparison table, because our pricing model is genuinely different. Copying a competitor
layout would import their product's shape into ours, which is a positioning error before
it is a legal one.

**6. Wholesale token-system cloning.** Modal ships ~200 `--semantic-*` tokens with a
`--color-raw-*` primitive layer beneath. That system is sized for a company with a
design team maintaining several surfaces. Ours is ~35 tokens over HeroUI's own names,
because HeroUI already derives the hover/soft/secondary variants for us via
`color-mix`, and every token we invent is a token someone has to keep correct in two
themes.

**7. together.ai's palette entirely — marketing and console.** The marketing orange and
cyan/purple are theirs; so is the **console's coral accent (≈`#E8674C`)**, which is the
specific colour we are differentiating *from*. No coral, salmon, terracotta or orange as a
primary accent, in any component, in any state, at any opacity. What we take from that site
is structural: tight radii, mono as a labelling device, the observation that a dark ground
can carry a hue, and the layout patterns catalogued in §0.3 and §3.9–3.11.

**8. Any hardware vocabulary that leaks into a consumer surface.** Modal is a compute
platform and talks about GPUs because that is what they sell. We sell capability. No GPU
name, tier, generation, VRAM figure, or silicon icon appears on the catalog, the model
card, the model detail page, the playground, or the console — not in a tooltip, not in a
`title` attribute, not in empty-state copy. The card shows measured tok/s and a context
window; which silicon delivers that is the platform's problem (FR-MKT-002).

The one boundary: Creator Studio's Deployment Plan card is where the PRD deliberately puts
hardware, as a **read-only result** the creator needs because they are accountable for the
cost floor (FR-STU-004, FR-STU-004b). It is never an input, and it never travels outward.
§3.11 states this precisely; nothing in that exception licenses a GPU name anywhere else.

**9. Parameter counts on a discovery card.** together.ai prints `2.8T`, `436.2B`, `29.8B`.
We do not. Size is a proxy the caller must translate before it means anything, and
translating it into throughput is the job we claim to do — we show the answer (measured
tok/s) rather than the input to a calculation. Reasoning about the proxy beside the
measurement invites the reader to distrust the measurement. §0.3 has the full argument.

**10. Compare, row checkboxes, and a `⋮` menu on public cards.** All three are right at
their catalog's scale and wrong at ours (§3.3). The `⋮` belongs on the creator's own rows,
where the actions are numerous and destructive, and nowhere else.

**11. A second view of the same rows before the catalog needs one.** Their
featured-cards-above-a-table is a good end state. Shipping it at MVP-0 buys two skeletons,
two empty states and two sort paths for a catalog that fits on one screen. The trigger to
revisit is written down in §3.3 (roughly 50 rows), so it is a scheduled decision rather
than a forgotten one.

**The goal, stated once:** someone who uses Modal daily should open this app and feel
that the people who built it have the same taste — dark, dense, monospaced where it
counts, one green, no ornament — and should not at any point think they are looking at
Modal.

---

## 5. Migration path

Ordered so that every step compiles, ships, and leaves the app usable. Each step is
independently revertable. Steps 1–4 are pure token work and change no component logic.

### Step 1 — Fonts (additive, no visual regression risk)

Add the two `next/font` declarations to `app/layout.tsx`, attach both `variable` classes
to `<html>`, and add the `@theme` block mapping `--font-sans` / `--font-mono`
(§2.1). Add `font-feature-settings: "cv11"` on `body` and
`font-variant-ligatures: none` on `code, pre`.

Nothing else changes. The app immediately stops rendering in system-ui — which is the
single largest perceived-quality jump available for the least risk, because today
`globals.css` declares no font at all.

*Done when:* `font-mono` resolves to JetBrains Mono in devtools, and there is no CLS on
first paint in either theme.

### Step 2 — Geometry and elevation

In `globals.css`, still inside the existing `@layer base` blocks:

- `--radius: 0.75rem` → `0.5rem`, and add `--field-radius: 0.375rem`.
- Add `--surface-shadow: 0 0 0 0 transparent` to **both** themes, and the
  `--overlay-shadow` pair from §1.5.
- Add `--motion-fast`, `--motion-base`, `--motion-ease`.

Then one component edit: delete `hover:shadow-md` from `model-card.tsx` and replace it
with `hover:border-border-strong hover:bg-surface-secondary transition-colors
duration-[--motion-fast]`.

*Done when:* nothing on any page casts a drop shadow except an open Modal in light mode,
and every corner is 4/6/8/12px.

### Step 3 — Neutrals

Replace the `--background` / `--foreground` / `--surface` / `--overlay` / `--muted`
values with §1.2, and **add** the tokens `globals.css` currently leaves to HeroUI's zinc
defaults: `--surface-secondary`, `--surface-tertiary`, `--separator`, `--border`,
`--border-strong`, `--default`, and the `-foreground` partners.

This is where the violet cast (hue 285.9) leaves the app. Because HeroUI computes
`--surface-hover`, `--border-secondary`, `--separator-secondary` and the whole `-soft`
family from these by `color-mix`, roughly forty derived colours correct themselves in
one edit.

*Done when:* light and dark both render, and no surface reads purple. Check the console
tables and the model card in both themes at 375px and 1440px.

### Step 4 — Accent, status, and syntax tokens

Replace `--accent`, `--success`, `--warning`, `--danger` and their `-foreground`
partners with §1.3, and add `--warning-text`, `--info`, `--info-foreground`,
`--link: var(--accent)`, and the five `--code-*` pairs from §1.4.

**This step has one required companion edit, and shipping it alone is a regression:**
`components/marketplace/highlight.ts` → `tokenClassName` currently returns
`text-success` for strings and `text-accent` for keywords. With a green accent those
become near-neighbours and syntax highlighting stops distinguishing anything. Repoint
all five cases at the `--code-*` tokens in the same commit.

*Done when:* a Python snippet shows five distinguishable colours in both themes, the
copy button's confirmed state is green, and the nav balance chip is green.

### Step 5 — Semantic chip cleanup

`components/marketplace/format.ts` → `qualityChipColor` stops returning
`"success"`/`"warning"` and returns `"default"` for every tier; the tier information
moves entirely into `qualityChipLabel`, rendered `font-mono`. Add `font-mono
tabular-nums` to the speed, context and price Chips in `model-card.tsx`.

This is the step that fixes two greens side by side, and it must land after step 4 so
the problem is visible while you fix it. Widen the tooltip copy if a tier label needs
more room; do not reintroduce colour to carry the meaning.

*Done when:* a card in dark mode has exactly one green chip.

### Step 6 — Border-token sweep

Mechanical, repo-wide, and worth doing as one commit so the diff is reviewable:

| Current | Replace with | Files |
|---|---|---|
| `border-default` | `border-border` | `site-nav.tsx`, `console-nav.tsx`, `primitives.tsx` (×3) |
| `divide-default` | `divide-separator` | `primitives.tsx` |
| `border-muted/25` | `border-border` | `code-block.tsx`, `home-intro.tsx` |
| `border-default border-dashed` | `border-border-strong border-dashed` | `primitives.tsx` (`EmptyPanel`) |
| `rounded-[calc(var(--radius)/1.5)]` | `rounded-[var(--field-radius)]` | `model-card.tsx`, `catalog-grid.tsx` |
| `rounded-[var(--radius)]` | `rounded-lg` | `code-block.tsx`, `home-intro.tsx` |

`--default` is HeroUI's neutral *fill* token, not a border colour; every current use of
it as a border is why the app's hairlines read as smudges instead of rules.

*Done when:* `grep -rn "border-default\|divide-default\|border-muted/" components app`
is empty.

### Step 7 — Typography roles

Apply §2.2 to the headings and figures that already exist: `PanelHeader`'s `h1`,
`HomeIntro`'s `h1` and Step cards, `Stat`'s label (to the mono `eyebrow` role) and value,
`Card.Title` across the board, table column heads, and the `<dl>` under `SnippetTabs`.

Then, and only then, the two layout changes: `xl:grid-cols-4` on `CatalogGrid` and
`max-w-[88rem]` on the catalog route's container (the console stays `max-w-6xl`).
These go last because they are the only edits that can reintroduce a 375px overflow, and
they are much easier to verify against a page that is otherwise finished.

*Done when:* every heading in the app maps to a named role in §2.2, no figure is missing
`tabular-nums`, and at 375px `document.documentElement.scrollWidth === clientWidth` on
`/`, `/models/[creator]/[slug]`, `/console`, `/console/wallet`, `/console/usage`,
`/console/keys`, `/playground`, `/login`, `/signup` — in both themes.

### Step 8 — App shell (the sidebar)

Only after steps 1–7 are green. Introduce the §3.0 left sidebar on authenticated routes
via a new `app/(app)/layout.tsx`-style boundary, keeping the public routes on the existing
centred layout. Keep `ConsoleNav` as the sub-`lg:` navigation rather than deleting it; the
sidebar and the horizontal tabs are two responsive states of the same information, not two
competing navs.

This is scheduled last because it is the only change that can break every authenticated
page simultaneously, and because it is far easier to judge a new shell against pages whose
type and colour are already right.

*Done when:* `/console/*` and `/playground` render the sidebar from `lg:` up and the
drawer below it, `/playground` collapses to icons-only, no route renders both navs at the
same breakpoint, and the 375px overflow check from step 7 still passes on every route.

### Step 9 — New surfaces (Creator Studio, playground upgrades)

These are builds, not migrations, and they are gated on the token work only — a new surface
written against §1–§3 needs no follow-up pass. Ordered by PRD priority:

1. **Creator Studio deploy form** (§3.11) — top P0. Build the §3.9 sticky-summary primitive
   as a shared component *first*, since Creator Studio, the Phase 3 fine-tuning form and
   the eventual wallet top-up all consume it. Getting it wrong three times is the
   avoidable outcome here.
2. **Capability chips on the model card** (§3.2) — needs the `supports_tools` flag surfaced
   in `CatalogModel` and `queries.ts`. Small, high value, and it removes a class of
   request-time failure.
3. **Deployment-tier filter** (§3.3) — one more URL-backed facet in `search-params.ts` and
   one more `Select` in the rail. Capability wording only.
4. **Playground `API view` and the `default`/unset pill** (§3.10).
5. **Compact pricing format** (§3.2) — only once a cached-input rate actually exists.

### Verification checklist for every step

- Both themes render (`next-themes` stamps `class` and `data-theme`; the CSS matches
  either — do not narrow the selectors).
- No horizontal document overflow at 375px.
- Every aligned figure has `tabular-nums`.
- No GPU or hardware term anywhere in the diff, including `title` attributes.
- `npm run check` passes (`oxlint` + `eslint` + all four `tsc` projects).
- No `onClick` on a HeroUI component; `Alert` takes `status`; `Chip` keeps `color` and
  `variant` as independent props.
- No coral, salmon or orange as an accent; the only warm colour in the diff is `--warning`
  or `--warning-text`.
- Throughput shown is `measuredTokensPerSecond`. Nothing in the diff renders a predicted
  figure on a consumer surface. (Predictions are legal in Creator Studio's Deployment Plan
  and consequence table, and only there, where they are labelled as predictions.)
- `@heroui/react` is imported only from modules behind `"use client"`. A Server Component
  fetches and passes plain serializable props.

---

## 6. Known frictions between the code as it stands and this target

Recorded here so nobody rediscovers them mid-migration.

1. **`--default` is used as a border colour in five places.** It is a fill token. Step 6.
2. **`highlight.ts` borrows status colours for syntax.** A green accent breaks it. Step 4
   fixes it in the same commit, and shipping step 4 without it is a visible regression.
3. **`qualityChipColor` returns `success`.** Puts a green chip beside the accent chip on
   every high-quality model. Step 5.
4. **`hover:shadow-md` on the model card** is the only drop shadow in the app and
   contradicts the border-plus-background elevation model. Step 2.
5. **`--radius: 0.75rem` also inflates `--field-radius`** to 18px through HeroUI's
   `calc(--radius * 1.5)`. Both need setting; fixing only `--radius` leaves pill inputs.
6. **No font is declared anywhere.** The app renders in `ui-sans-serif`. This is a
   feature for the migration — step 1 is additive and has nothing to undo.
7. **`globals.css` overrides only nine of HeroUI's tokens.** Borders, separators,
   surfaces-secondary/tertiary and fields still come from HeroUI's zinc defaults at hue
   285.9, so the app is currently *two* neutral ramps. Step 3 unifies them.
8. **`rounded-[calc(var(--radius)/1.5)]`** appears twice as a hand-rolled derivation of a
   value HeroUI already exposes as `--field-radius` / `rounded-field`.
9. **The catalog is `max-w-6xl` with `lg:grid-cols-3`,** so FR-MKT-001's 4-column desktop
   layout is unimplemented. Deliberately last (step 7) — it is the only change that can
   reintroduce a 375px overflow.
10. **`BalanceChip` is hard-coded to $5.00.** Once the accent is green, a green chip
    asserts "funded" more strongly than it does today, so the `(placeholder)` suffix
    matters more, not less. Keep it until the Realtime subscription lands.
11. **Every route shares one `max-w-6xl` container in `app/layout.tsx`.** The §3.0 sidebar
    needs a route-group layout boundary that does not exist yet, so step 8 is a structural
    change to the root layout rather than a CSS change. Plan it as such.
12. **`ConsoleNav` and the §3.0 sidebar overlap in purpose.** They must be responsive
    states of each other (`lg:hidden` / `hidden lg:flex`), not two navs rendered together.
    Rendering both at any breakpoint is the failure mode to watch for in step 8.
13. **`supports_tools` is not in `CatalogModel`.** The capability chips in §3.2 need it
    plumbed through `types.ts` and `queries.ts` first. This is the one item in this
    document that needs a data change before a visual one.
14. **`Chip` is already carrying five items on the model card at 375px.** Adding a
    capability row and a tier chip makes wrapping behaviour load-bearing. `flex-wrap
    gap-2` on the metric row and `gap-1.5` on the capability row is the tested
    combination; verify at 375px before assuming it still fits.
15. **`Button` cannot take an `href`,** which is why `model-card.tsx` and
    `catalog-grid.tsx` style bare `<Link>`s to look like Buttons. Those hand-written
    classes are the one place button styling can drift from HeroUI's. If a third case
    appears, extract a single `LinkButton` recipe rather than copying the classes again.
