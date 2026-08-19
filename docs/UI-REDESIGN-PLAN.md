# UI/UX redesign — research and plan

> **Status:** proposal. Nothing here is normative until accepted.
> **Extends:** `docs/DESIGN.md` (normative visual language — tokens, type, component
> recipes). This document does **not** restate it and does not overrule it. Where the
> two disagree, `DESIGN.md` wins unless this document says explicitly that it supersedes
> a numbered section, which it does in exactly two places (§3.0 sidebar width, and §5
> step 8 sequencing).
> **Bound by:** `docs/PRD-inference-marketplace-mvp.md` §4.1.0 (HeroUI v3 constraints).
> **Measured:** 2026-08-18, from live sites, in a real browser, with computed styles read
> off the DOM. Every number below was sampled, not remembered.

---

## 0. The ask, restated

The app "works and looks plain." Three concrete moves were requested:

1. **The authenticated app gets a collapsible side menu** — `api.together.ai`'s shape,
   built on HeroUI's `AppLayout` pattern.
2. **Model discovery gets rebuilt** around `orcarouter.ai`'s search experience.
3. **The landing page gets rebuilt** as a mix of `modal.com` and `resend.com`, keeping
   Modal's floating top nav **for marketing only** — the app view does not get a top nav
   bar, it gets the sidebar.

That decomposes into a rule the rest of this document follows:

> **Two shells, one token system.** A visitor is reading a document; a developer is
> operating a tool. Marketing gets the pill nav and a centred column. The product gets a
> sidebar and full-bleed content. They share `globals.css` and nothing else structural.

`DESIGN.md` §3.0 already reached the same conclusion independently. This plan is its
step 8, brought forward and specified far enough to build.

---

## 1. Where the code actually stands

Steps 1–7 of `DESIGN.md` §5 landed in `78e8010` (fonts, geometry, neutrals, accent,
chips, border sweep, type roles). What remains untouched:

| Surface | State today | Gap |
|---|---|---|
| `app/layout.tsx` | One `max-w-6xl` centred column + `SiteNav` for **every** route | No route-group boundary; marketing and product share a shell |
| `components/site-nav.tsx` | 56px flush sticky header, 2 links | Not a pill; no product nav; no command palette |
| `app/page.tsx` | `HomeIntro` (chip + h1 + Alert + 3 steps) then the catalog inline on `/` | Landing and catalog are the same page; no social proof, no code sample, no section rhythm |
| `components/console/console-nav.tsx` | Horizontal underline tabs, 4 routes | Correct as the **mobile** state; wrong as the only state |
| `app/studio/*` | **Landed in `c70e1e1`.** Deploy form, deployment plan, variant table, provisioning stepper, My Models table, 3 API routes, 2 migrations | Its own `StudioNav` + `flex flex-col gap-6` shell, parallel to `ConsoleNav`. Two shells now, both needing the same replacement |
| `components/marketplace/catalog-controls.tsx` | Search + 5 `Select` facets in a wrap row + active chips | Facets are a horizontal row, not a rail; no counts; no category tabs |
| `components/marketplace/model-card.tsx` | 5 chips in one wrap row, `Code` modal + `Try it →` | No capability chips, no price table, no "what $X buys", no copy-id affordance |
| `app/playground/page.tsx` | h1 + `<Chat>` in the centred column | No parameter rail, no API view, no model switcher |
| `app/models/page.tsx` | 12 lines | Effectively a stub |

Everything in `DESIGN.md` §6 ("known frictions") that concerned tokens is now fixed. The
frictions that remain are all structural: items **11** (one shared container), **12**
(`ConsoleNav` vs sidebar — now **two** such navs), **13** (`supports_tools` not plumbed),
**15** (`Button` takes no `href`).

**Studio's arrival makes the shell urgent rather than merely overdue.** There are now
three horizontal sub-navs (`SiteNav`, `ConsoleNav`, `StudioNav`) and a conditional
`Studio` link in the root nav that is hidden below `sm:`. A signed-in creator on a phone
cannot currently reach `/studio` from the UI at all. Phase D fixes that as a side effect,
which is the clearest argument that the sidebar is a functional fix and not a restyle.

*(Two token regressions arrived with Studio and were swept on the spot: `border-default`
used as a border colour in four files — it is a **fill** token, `DESIGN.md` §3.1 and §6
item 1 — and a missing `overflow-y-hidden` on `StudioNav`'s tab strip, which
`console-nav.tsx` documents as load-bearing against a stray vertical scrollbar.)*

### 1.1 Live-site audit — `custom-ai-one.vercel.app`, 2026-08-18

Read off the deployed app, not the source. Ordered by whether it is a defect or a design
gap, because they get fixed in different phases.

**Defects.**

| # | Where | What | Fix |
|---|---|---|---|
| L1 | `/studio/new` | A stray **vertical scrollbar** on the sub-nav tab strip. The `-mb-px` tabs overflow the `<ul>` by one pixel and CSS promotes the y axis from `visible` to `auto` on its own | **Fixed.** `overflow-y-hidden` added to `StudioNav`, matching `ConsoleNav`'s documented pattern |
| L2 | four `components/studio/*` files | `border-default` used as a border colour | **Fixed.** → `border-border` |
| L3 | `/playground` | Cold-start copy is a loose `<p>` hanging under the parameter card, owned by nothing and styled as an afterthought | Fold into the card as a footer, or promote to the `ColdStartNotice` treatment. Phase H |
| L4 | `/playground` | Empty transcript is a dashed box reading *"Send a message to wake the worker."* — no `EmptyState`, no suggested prompt, no statement of what the model is for | `EmptyState` with 2–3 seed prompts that fill the composer on press. Phase H |

**Unconfirmed.** The grey blocks behind `Parameters`, `Temperature`, `0.7`, `Max tokens`,
`System prompt` in the playground screenshot fall in exactly one contiguous document range
and skip the textarea placeholder (placeholders are not selectable). **That is the
signature of a drag-selection, not a style bug** — the same rail is clean in the `/studio`
screenshot. Reproduce with a fresh load before treating it as a defect; if it survives a
reload, it is a `--default` fill landing on `Label`/`Card.Title` and it belongs in the L2
sweep.

**Design gaps** — the substance of the ask, not bugs.

| # | Where | What |
|---|---|---|
| L5 | `/playground` | **The real complaint.** The model is hardcoded from `NEXT_PUBLIC_DEFAULT_MODEL` and production has zero models (`ROADMAP` "what deployed does not yet mean"). The page names a model with authority whether or not one exists, and offers no picker. This is `ROADMAP` #6 (`/playground/[creator]/[slug]`) and it is a **product** fix that the shell work cannot substitute for |
| L6 | `/playground` | The id renders as `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` — HF casing — while the catalog, every snippet and `CONTRACTS.md`'s own example use the lowercase platform id. Not a 404: `resolve.ts` lowercases both halves, so it resolves and streams today (`CONTRACTS.md` §model id, which records that two earlier revisions of this contract were wrong in *both* directions). It is a **presentation** inconsistency resting on a coincidence — this seed's handle and slug happen to equal that path lowercased, and it stops being true the moment they diverge. Render the platform id |
| L7 | `/login`, `/signup` | A bare `Card` floating in `min-h-[calc(100dvh-8rem)]` — a magic number tied to the nav height. No wordmark, no value proposition, nothing beside the form. Every reference (Resend, Modal, together) pairs the form with a brand panel or at minimum a lockup. See §7 |
| L8 | root nav | `Playground` and `Studio` sit beside the wordmark as bare text links, and `Studio` is `hidden … sm:inline`, so a signed-in creator on a phone cannot reach it at all. Phases B (marketing nav) and D (sidebar) between them delete this surface |

---

## 2. Research — what was measured

### 2.1 HeroUI `AppLayout` (heroui.pro)

**This is a paid product and it is not the package we have installed.** `AppLayout`,
`Sidebar` and `Navbar` are exported from `@heroui-pro/react`. `node_modules/@heroui/react@3.2.4`
ships 80 component directories and **none of them is `sidebar`, `navbar` or `app-layout`**.
See §9 — this is decision **D1** and it gates the whole shell.

Anatomy and props, from the docs:

- `<AppLayout sidebar navbar aside toolbar footer>` — wraps a `Sidebar.Provider` internally.
- `AppLayout.MenuToggle` (mobile sheet opener) · `AppLayout.AsideTrigger` · `AppLayout.MobileAside`.
- `sidebarVariant`: `"sidebar" | "floating" | "inset"`.
- `sidebarCollapsible`: `"icon" | "offcanvas" | "none"`.
- `sidebarSide`: `"left" | "right"`. `scrollMode`: `"page" | "content"`.
- `toggleShortcut` defaults to **`mod+b`**; `asideToggleShortcut` for the right panel.
- Resizable: `sidebarResizable`, `sidebarDefaultSize/MinSize/MaxSize`, `resizableAutoSaveId`.
- `useAppLayout()` → `{ isAsideOpen, setAsideOpen, toggleAside }`.

Measured off the live `app-layout-default` demo (dark, fullscreen):

| Thing | Value |
|---|---|
| Sidebar width, expanded | **240px** |
| Sidebar width, `collapsible="icon"` collapsed | **48px** |
| Collapse transition | `width 200ms`, `box-shadow 150ms cubic-bezier(0,0,.2,1)` |
| Sidebar header | 64px tall, padding `16px 16px 8px` |
| Sidebar content | padding `0 12px`, item gap `4px` |
| Sidebar footer | padding `8px 12px 16px` |
| Menu icons | 16px |
| App header | 64px, `position: sticky`, **transparent** background |
| State surface | `data-state="expanded|collapsed"`, `data-collapsible`, `data-side`, `data-variant` on the `<aside>` |
| Mobile | desktop sidebar hidden ≤768px, replaced by a sheet; `aside` hidden ≤1024px |

The demo's sidebar carries a header (logo lockup), a scrollable content region with
grouped menus, a collapsible group (`Analytics ⌄`), an inline `New` badge on one item, and
a footer holding `Help & Information` / `Log out`.

**Takeaway:** the anatomy is ordinary and the numbers are the value. Whether we buy the
package or rebuild it, the shell is 240/48/64 with a 200ms width transition and `mod+b`.

### 2.2 `api.together.ai` — the console we are matching

| Thing | Value |
|---|---|
| Sidebar width | **240px** |
| Sidebar background | `#181616` |
| Page background | `#0b0707` — **darker than the sidebar** |
| Sidebar right border | `1px solid #353235` |
| Nav item | 32px tall, `border-radius: 8px`, 14px / weight 400 |
| Active item | **colour only** — coral `#ff815d` text and icon, no fill, no left rule |
| Group labels | `Inference`, `Model Shaping` — muted, small, no icon, no rule |

Structure: collapse toggle · wordmark · **project switcher** (`Default Project ⌄`) in the
sidebar header. Then ungrouped top items (Dashboard / Models / Playground), then labelled
groups, then ungrouped tail (GPU Clusters / Analytics / Files / Settings). The top-right of
the *content* area — not a full-width header — carries new-thing `+`, panel toggle,
feedback, theme toggle, avatar.

The dashboard body: a read-only-mode `Alert` banner, then `</> Developer Quickstart` as an
**icon-prefixed h1** with a one-line subtitle, then a code card whose header holds a
`Chat ⌄` scenario select on the left and copy + `Python | TypeScript | curl` tabs on the
right, then `Do more with your APIs` — a section header with a right-aligned `Read the
docs` button over a 4-up grid of icon-badge action cards.

Their `/models` page: `Featured Models` 4-up cards → `Browse Models` section header with
right-aligned `Deploy custom model` / `Upload a model` → `All models | My models` tab pair
+ search field + `Compare` → left filter rail of checkbox cards → sortable table with row
checkboxes and a per-row `⋮`.

**Takeaway, and it is mostly negative:** we take the *sidebar* and the *section-header
with a right-aligned action*. `DESIGN.md` §4 items 10 and 11 already ruled the table,
the checkboxes, the `⋮` and `Compare` out of scope at our catalog size, and that ruling
stands — we have single-digit models, not 197.

The one thing worth stealing that we do not have: **the quickstart code card as the
dashboard's hero.** Our `/console` opens on a wallet card. The first thing a developer
needs is the four lines that make a request work.

### 2.3 `orcarouter.ai` — the model search we are matching

Landing: light ground, centred hero, `One gateway. Every model.` at ~56px, one blue pill
CTA + a plain-text secondary link, microcopy `No credit card · live in 60 seconds`, then a
**6-up stat strip** (`200+ / 0% / 75.5% / <50ms / 40+% / <1%`) where each stat has a muted
label *and* a smaller italic caption, then a tabbed code sample (`Python · TypeScript ·
cURL · Agents`).

`/models` is the reference that matters:

- **Page head:** `Models` + `197 models · 16 providers · one API key, one bill`.
- **Left facet rail**, ~200px, each facet a `Disclosure` row with a 16px icon and a `›`:
  `Input modalities · Context length · Input price ($/1M) · Status · Series · Supported
  parameters`. `Clear filters` as a plain link beneath.
- **Controls row:** search field (`Search models`) · grid/list **view toggle** ·
  `SORT` eyebrow + a `Newest` select.
- **A dismissible onboarding card** — `How to call any model`, three numbered steps on the
  left, a copyable model-id chip and a live `POST` snippet on the right, `API Docs ↗`, `×`.
- **Category tabs with counts:** `All 197 · Text 162 · Image 10 · Embeddings 5 · Video 10 · TTS 10`.
- **Card grid**, 5-up at 1568px, variable height. Per card:
  - provider glyph + `Provider: Model Name`
  - a **mono model-id chip with a copy button**, and a `</>` icon button beside it
  - 2-line clamped description
  - capability chips with an **overflow counter**: `Vision · Tools · Reasoning · +1`
  - context as a **large mono figure with a small uppercase label**: `262K CONTEXT`
  - an eyebrow rule `PER 1M TOKENS · BASE RATE` with an optional right-aligned `Peak ×2`
  - a price table: `INPUT / OUTPUT / CACHE READ` labels left, mono tabular figures right
  - a footer that translates price into value: `$100 of credit buys — 71M input / 22M output tokens`
  - state chips where they apply: `Offer`, `FREE`, `Security Research`, and a
    `Sign in to enable access` CTA on a gated card

**Takeaway:** four patterns are directly ours — the **facet rail**, the **counted category
tabs**, the **copyable mono id**, and the **price-to-value footer**. The last is the
strongest idea on the page and we have the data for it today.

### 2.4 `modal.com` — the marketing nav

| Thing | Value |
|---|---|
| Nav element | `<nav class="rounded-full grid grid-cols-[1fr_auto_1fr]">` — a **floating pill**, not a bar |
| Height | 48px |
| Fill | `#212525` on a `#000` page |
| Shadow | `0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1)` |
| Container | `max-width: 1400px`, `padding: 0 48px` |
| Link text | **`#ddffdc`** — a pale green-white, not white |
| Link size | 14px / 500 |
| CTA text | `#7fee64` on a 6px-radius chip |

The three-column grid is what makes it work: logo left, links dead-centre, auth right. A
full-bleed announcement strip sits **above** the pill, edge to edge.

Sections in order: hero → SDK → runtime → elastic capacity → production-ready → workloads
→ inference → training → sandboxes → global infra → security → customers → examples → CTA
→ footer.

### 2.5 `resend.com` — the landing rhythm

| Thing | Value |
|---|---|
| Page ground | `#000` |
| Body text | `#f0f0f0`; muted `#a1a4a5` |
| Header | 58px, sticky, **fully transparent**, no border, no backdrop blur |
| h1 | **96px / weight 400 / line-height 1.0 / letter-spacing −0.01em**, in `domaine` (a licensed serif) |
| Subhead | Inter 18px / 27px |
| Hero CTAs | one dark-grey pill + one plain text link |

Their nav is centred links with `⌄` dropdowns, `Log in` + a `Get started` pill.

Section rhythm, and this is the part to copy: **display h2 → one muted sentence → a
product artifact.** Never an illustration. `Integrate tonight` sits over a real SDK code
block; `Test mode` and `Modular webhooks` are sub-features under one h2; the logo wall is
a two-line lead-in over monochrome marks.

**What we cannot take:** `domaine` is licensed, exactly like Modal's `Goga`
(`DESIGN.md` §4 item 1). Our hero gets its scale from Inter at 400/500 with tight tracking
— which is a real constraint, and it means our h1 tops out around 64px, not 96px.

---

## 3. Target architecture — three route groups

The single change that unblocks everything else. `app/layout.tsx` keeps `<html>`, fonts,
`ThemeProvider` and `<body>` and **stops rendering `SiteNav` and the `max-w-6xl` main**.
Those move down into two new group layouts.

```
app/
  layout.tsx                 ← html/body/fonts/theme only. No nav, no container.
  (marketing)/
    layout.tsx               ← MarketingNav (pill) + footer, full-bleed sections
    page.tsx                 ← NEW landing page (moved from app/page.tsx)
  (catalog)/
    layout.tsx               ← MarketingNav + max-w-7xl centred column
    models/page.tsx          ← the catalog, moved off `/`
    models/[creator]/[slug]/page.tsx
  (app)/
    layout.tsx               ← AppShell: sidebar + sticky content header
    console/…                ← moved from app/console
    studio/…                 ← moved from app/studio (landed c70e1e1)
    playground/…             ← moved, gains the aside rail
  (auth)/                    ← unchanged; already its own group
```

`app/studio/layout.tsx` and `app/console/layout.tsx` are now the same file twice: a
`getCurrentUser()` guard, a redirect, and `<div class="flex flex-col gap-6">` around a
sub-nav. Phase A collapses the guard into `(app)/layout.tsx` — **and the per-route guard
must be kept, not deleted**, for the reason both files already state in a comment: the
middleware matcher is a regex someone will edit one day. One guard in the group layout is
one guard for both route tables, which is strictly better than two copies, but it is still
the second line of defence and not the first.

Consequences worth naming before the work starts:

- **`/` stops being the catalog.** It becomes the landing page and the catalog moves to
  `/models`. `app/models/page.tsx` exists as a stub today, so the route is free. This
  needs a `301` from any indexed `/?q=…` URL — `app/page.tsx`'s `generateMetadata`
  already marks filtered views `noindex, follow`, so the exposure is one URL.
- The catalog stays **server-rendered and indexable** (FR-MKT-006). Route groups do not
  change rendering, only nesting.
- `(catalog)` and `(marketing)` share `MarketingNav`. They differ only in the container:
  marketing sections are full-bleed, the catalog is a centred column.
- `middleware.ts` matches on pathname, not route group, so **it needs no change** — but
  its matcher regex must be re-read against the new `/studio` path when Studio lands.

---

## 4. The landing page

`/` — a marketing document. Dark-first, and the one surface where the accent may appear
more than once per viewport.

**Nav — Modal's pill, our tokens.** A `<nav>` at `h-12 rounded-full bg-surface-secondary`
inside a `max-w-7xl px-6` container, `sticky top-4 z-40`, with the
`grid-cols-[1fr_auto_1fr]` split: wordmark left, links centred, `Sign in` + a solid accent
`Get started` right. No backdrop blur — Modal does not use one and it costs a compositor
layer. Shadow only in light mode (`DESIGN.md` §1.5: dark elevation is background step plus
hairline). Below `md:` it degrades to wordmark + hamburger opening a HeroUI `Drawer`.

**Sections, in order.** Each is `display h2 → one muted sentence → a product artifact`.

| # | Section | Artifact | Notes |
|---|---|---|---|
| 1 | Hero | none | Announcement `Chip` (Resend's pill) → h1 at `clamp(2.5rem, 6vw, 4rem)`, weight 500, tracking `−0.03em` → 2-line subhead → solid accent CTA + a plain `Browse models` link → microcopy line |
| 2 | Proof strip | 4 stats | Orca's stat strip, honestly filled from `HANDOFF.md`: measured tok/s, cold-start seconds, **80% to the creator**, `$0` idle. Each gets Orca's second, smaller caption. `tabular-nums`, mono figures |
| 3 | Two-line diff | code block | "Change two lines" — a `CodeBlock` with the base-URL and model lines highlighted. Reuse `snippet-tabs.tsx`, do not write a second code component |
| 4 | The tradeoff | `Alert status="warning"` | The cold start, stated as loudly as `home-intro.tsx` states it today. **This section is non-negotiable** — it is the reason the product is cheap, and burying it is the most expensive omission available (`home-intro.tsx`'s own comment, and it is right) |
| 5 | Featured models | 3 model cards | The real `ModelCard`, live from the catalog, with `Browse all N models →`. Sells the supply side and doubles as the catalog's entry point |
| 6 | For creators | numbered steps | The 80/20 split, the "no GPU to pick" claim, `Deploy a model →` |
| 7 | Compatibility | logo/word row | The clients that work unmodified: OpenAI SDK, LangChain, Aider… **Only list what is verified.** Tool calling is a `ROADMAP` P2 — anything gated on it is a lie until §7 ships |
| 8 | Closing CTA + footer | — | |

**Explicitly not built:** the particle globe, the scroll-linked hero, the horizontal
auto-scroll band, any 3D render (`DESIGN.md` §4 item 3). Motion on this page is limited to
`opacity`/`transform` reveal on section enter, ≤200ms, disabled under
`prefers-reduced-motion`.

**The `HomeIntro` component survives.** Its Alert and its 3-step block move into sections
4 and 6 nearly verbatim. The copy is good; only its container changes.

---

## 5. The app shell

`app/(app)/layout.tsx`. This is the largest structural change and the one that can break
every authenticated route at once, so it ships behind the token work and gets its own
verification pass.

**Geometry** (supersedes `DESIGN.md` §3.0's `w-52`, on the evidence: both HeroUI Pro *and*
together.ai independently land on 240):

| | |
|---|---|
| Expanded | `240px` |
| Collapsed (icon rail) | `48px` |
| Transition | `width 200ms var(--motion-ease)`, inert under `prefers-reduced-motion` |
| Breakpoint | sidebar from `lg:` up; below that a `Drawer` behind a hamburger |
| Toggle | a rail button **and** `mod+b` |
| Persistence | collapsed state in `localStorage`, read in a `useLayoutEffect` — a cookie would be better (no flash) and is the upgrade if the flash is visible |
| Colour | `bg-surface` sidebar on a `bg-background` page, `border-r border-border`. In dark this makes the rail *lighter* than the page, which is what together.ai does and what our token ramp already produces for free |

**Content.**

```
header   wordmark · [collapse toggle]
content  Overview · Playground · Models
         ── Console ────────────────────      (eyebrow: mono, uppercase, tracked, muted)
         API keys · Usage · Wallet
         ── Studio ─────────────────────
         My models · Deploy a model
footer   Docs · theme toggle · user menu
```

- Item: `h-8 rounded-md px-3 text-sm` with a 16px outline icon and `gap-3`.
- **Active item:** `bg-surface-secondary text-foreground font-medium` **plus** a 2px
  `bg-accent` left rule. together.ai uses colour alone; we add the fill because our accent
  is green and green-as-text at 14px is the weakest contrast case in our palette. Not a
  filled accent pill — one green element per viewport still holds (`DESIGN.md` §4 item 2).
- Collapsed: icon only, label in a `Tooltip` on hover **and** focus. Eyebrows become a
  `Separator`. Never let a tooltip be the only route to a label.

**Content header** — a 56px sticky row inside the content column, not a full-width bar
(the sidebar owns the full height). Left: `Breadcrumbs`. Right: `BalanceChip` ·
`ThemeToggle` · `UserMenu`. Below `lg:` the hamburger takes the left slot.

**`ConsoleNav` and `StudioNav` both stay**, `lg:hidden`, as the sub-`lg` navigation for
their own route tables. Two nav mechanisms is correct here; rendering both at any one
breakpoint is the failure mode to test for (`DESIGN.md` §6 item 12). They are already
identical but for their `ITEMS` array and `aria-label` — extract one `SubNav` taking
`items` and a label, and delete the duplicate rather than adding a third when the next
route table lands.

**The `Studio` link comes out of `SiteNav`.** It is conditional on a session and
`hidden … sm:inline` today, so a signed-in creator on a phone cannot reach `/studio` from
the UI at all. In the sidebar it is an ordinary item under the `Studio` eyebrow, present
at every width, and `SiteNav` goes back to being a marketing nav with no product links.

**`/playground` gets the right `aside`.** Sidebar collapsed to the 48px rail by default,
transcript in the centre, parameter rail in a 288px `aside` that toggles. That is exactly
`AppLayout`'s `aside` slot, and it is what the `sidebarSide: "right"` question in the
original ask resolves to: the *navigation* is on the left, and a *right* panel exists as a
separate, page-specific thing.

---

## 6. Model discovery

`/models`. Keeps every URL-backed behaviour in `search-params.ts` — the URL is the state,
and that decision is right and stays.

**Layout:** `grid lg:grid-cols-[220px_1fr] gap-8`. Facet rail left, results right. Below
`lg:` the rail collapses into a `Drawer` behind a `Filters (2)` button whose count is the
number of active facets.

**Facet rail.** The five `Select`s in `catalog-controls.tsx` become five `Disclosure`
groups, Orca's shape, each opening to `Radio` rows so the whole facet is visible at once
rather than one-value-at-a-time behind a popover:

```
Speed          ▸   Any · 20+ · 40+ · 60+ · 90+ · 120+ tok/s
Context        ▸   Any · 8K+ · 32K+ · 128K+ · 200K+ · 1M+
Quality        ▸   the six-rung ladder, `full` labelled and explained
Price          ▸   budget · standard · premium
Creator        ▸   only when >1 creator exists
Clear filters
```

**Controls row:** `SearchField` (existing, 300ms debounce, keep it) · result count ·
`SORT` eyebrow + the sort `Select`. The **view toggle is not built** — one view, cards.
Orca has 197 models and earns a table; we do not (`DESIGN.md` §4 item 11 wrote the
trigger down at ~50 rows, and that trigger holds).

**Category tabs with counts** are the one Orca pattern that needs data we do not have:
counts require a `GROUP BY` the current query does not run. Ship the tabs only when
there is a second category to tab between; today every model is text-in/text-out.
**Deferred, with the trigger written down: the first non-text model.**

**Model card, rebuilt.** Current: five chips in one wrap row. Target, in order:

1. Title row — `creator/slug` in mono, **plus a copy-id button**. Orca's copy affordance
   is the highest-frequency action on a catalog card and we make people select text.
2. 2-line clamped description.
3. Capability chips — `Tools`, `Vision`, `JSON mode`, with a `+N` overflow chip.
   **Blocked on data:** `supports_tools` is not in `CatalogModel` (`DESIGN.md` §6 item 13).
   Plumb it through `types.ts` and `queries.ts` first.
4. The headline figure pair, Orca's treatment — large mono value, small uppercase label:
   `14 TOK/S` and `262K CONTEXT`. This replaces two chips with two figures and is a real
   legibility gain.
5. `Separator`, then the eyebrow `PER 1M TOKENS`, then a two-row price table:
   `INPUT` / `OUTPUT`, labels left, `tabular-nums` right.
6. **The value footer — take this.** `$5 buys ~3.5M input / 1.1M output tokens`, computed
   from the two prices we already store. It converts a per-token price into the only
   question a developer actually has.
7. Footer: `Code` modal (existing) + `Try it →`.

**Not taken:** row checkboxes, `Compare`, per-card `⋮`, parameter counts, provider logos
(we have creators, not providers — a creator handle is the identity).

**Model detail page** (`/models/[creator]/[slug]`) gets the §3.9 sticky-summary shape:
`grid lg:grid-cols-[1fr_20rem]`, prose and snippets left, a sticky spec panel right
carrying the figures, the price table, the value line, and `Try in playground`.

---

## 7. Console, playground, studio

**Console overview.** Lead with the quickstart, not the wallet — together.ai's ordering
and it is right. New order: `Alert` (empty wallet / no keys, when true) → **Quickstart
code card** with a real key placeholder and language tabs → wallet stat row → usage
sparkline → the three `LinkCard`s. The `Stat` and `LinkCard` primitives already exist in
`components/console/primitives.tsx` and are reused as-is.

**Tables** (`keys-panel`, `usage-panel`, `wallet-panel`): `DESIGN.md` §3.5 governs. The
one addition here is a **sticky table header** on the usage table, which is the only table
that routinely runs past a viewport.

**Playground:** `DESIGN.md` §3.10 governs the visual treatment and is unchanged. The shell
work in §5 is its prerequisite — the parameter rail is the `aside`, and there is nowhere
to put it today. Three additions from the live audit (§1.1), in priority order:

1. **A model picker, and honest behaviour when there is no model** (L5). The route becomes
   `/playground/[creator]/[slug]` with `/playground` resolving to the caller's last-used
   model, or to the catalog's first ready model, or — when the catalog is empty — to an
   `EmptyState` that says so and links to `/studio/new`. A hardcoded env model that names
   a thing which may not exist is the single least trustworthy surface in the app.
   `NEXT_PUBLIC_DEFAULT_MODEL` survives only as a dev convenience, never as the render.
2. **Render the platform id, lowercase** (L6), the same string every snippet tells the
   caller to paste. The HF-cased form resolving is a coincidence, not a contract.
3. **A real empty state** (L4) with 2–3 seed prompts that fill the composer on press, and
   the cold-start line folded into the card that owns it (L3).

**Auth (`/login`, `/signup`) — a two-panel page** (L7). The form card is correct and its
internals stay: GitHub first at `variant="primary"`, the `or with email` separator, email
+ password at `variant="secondary"`. That hierarchy is deliberate and it is right. What
changes is everything around it:

- `grid lg:grid-cols-2 min-h-dvh`. Form left in a `max-w-[26rem]` column; right panel is a
  `bg-surface` field carrying the wordmark, one sentence of value proposition, and the
  same proof figures as landing section 2. Below `lg:` the right panel drops entirely and
  the form centres — which is today's layout, so mobile does not regress.
- The wordmark goes **on the page**, above the card, linking home. A sign-in box with no
  branding is the thing that reads as unfinished.
- Delete `min-h-[calc(100dvh-8rem)]`. It encodes the nav height as a constant, and phase A
  changes that height. `min-h-dvh` on the grid, with the nav inside it, needs no constant.
- `(auth)` keeps its own layout and does **not** join `(app)` — it is unauthenticated by
  definition and gets neither the sidebar nor the marketing pill.

**Creator Studio: built, and it followed §3.11.** `c70e1e1` shipped the deploy form, the
sticky Deployment Plan panel, the variant consequence table, the provisioning stepper, the
My Models table and the `.field-reveal` conditional-field animation — including the one
documented layout-animation exception, inert under `prefers-reduced-motion`. Nothing in
this plan asks for it to be redesigned.

**One defect found and fixed: the visibility Switch was inert.** `Switch.Content` is not a
content slot — it is React Aria's `SwitchButton`, the element that renders the hidden
`<input>` and owns every press target (`@heroui/styles` says so in its own source
comment). The form nested `Switch.Control`/`Switch.Thumb` *outside* it, so the thumb still
slid — the root carries `data-selected`, and the CSS keys off `.switch[data-selected]` —
while the track itself was dead to a click. Only the word "Public" toggled anything, which
is why it read as stuck. `Description` was also inside `Switch.Content`, i.e. a `<p>`
inside a `<label>`, so clicking three lines of explanatory prose silently flipped the
model's visibility.

**`DESIGN.md` §3.11's field table specified this composition and specified it wrong**; the
implementer followed the spec faithfully. Both are corrected.

### 7.1 Creator Studio — three open questions

**Q: does a required prompt price make sense for a private model?** Yes, and it must stay
required. A private model is not an unbilled one: `resolve.ts:234` 404s a *non-owner* and
lets the owner straight through, after which `authorize_request` and `deduct_token_cost`
run exactly as they do for a public model. Schema agrees — `price_prompt_micro_usd_per_mtoken`
is `not null`. Private means *unlisted and access-controlled*, never *free*.

What is wrong is the **framing**, not the requirement. Today the field reads
`Prompt price · per 1M tokens` with a cost-floor hint, which for a private model looks
like pricing a product nobody can buy. Two changes:

- When `isPublic` is false, the section lede becomes what the number actually does:
  *"Private models are still metered and still billed. This is what your own calls cost
  you — the platform keeps its fee, and the cost floor is what the hardware costs us."*
- **Default private prices to the cost floor rather than to `0.5 / 1.5`.** A creator
  pricing a private model has no market to reason about, so the only defensible default is
  break-even. The below-floor warning then matters *more* for private, not less: a creator
  who zeroes it out is not discounting a customer, they are handing the platform the GPU
  bill.
- The Switch description now says so inline (shipped with the fix above).

**Q: should Revision be a dropdown?** Yes — a **`ComboBox` with `allowsCustomValue`**, not
a `Select`. Branches and tags are enumerable; commit SHAs are not, and pinning a SHA is
the whole point of a revision field for anyone who cares about reproducibility. A closed
`Select` would remove a capability.

The data is one request we do not yet make. `packages/hf-probe/src/hf.ts` already calls
`/api/models/{slug}` and `/api/models/{slug}/tree/{revision}`; HF exposes
`/api/models/{slug}/refs` on the same host and the same auth, returning `branches` and
`tags`. Sequence: on repo-slug blur, fetch refs first, populate the ComboBox, preselect the
repository's actual default branch, *then* run the weight probe against the chosen
revision.

That ordering also fixes a silent failure: the field free-texts to `"main"` today
(`deploy-form.tsx:94`, and `|| "main"` twice more), so a repository whose default branch is
not `main` probes a ref that does not exist — and this codebase's recurring lesson is that
those fail quietly.

**Q: does the cost floor make sense for the same GPU? Are we considering multiple GPU
clusters?** No clusters — the solver picks exactly **one** tier per variant. It walks
`gpu_tiers` `order by usd_per_hour_micro asc` and takes the first that fits
(`20260817001700_hybrid_attention.sql:178`, `:216` — *"tiers iterate cheapest-first: first
hit wins"*). Rows differ in `Runs on` because each variant has different weights, so a
different tier becomes the cheapest one it fits on.

The floor is **not** a function of the GPU alone:

```
cost_floor = (usd_per_hour ÷ 3600) × (1e6 ÷ (tok_s × max_concurrent_streams × assumed_utilisation))
```

with `assumed_utilisation = 0.35`, and

```
max_concurrent_streams = floor( (usable_vram − weights − overhead) × (1 − prefix_reserve) ÷ bytes_per_stream )
```

**The dominant term is `max_concurrent_streams`, and the table does not show it.** That is
the whole confusion, and it is a real defect in the consequence table rather than a
misreading. Two same-GPU rows at 14.0 GiB / 50 tok/s → `$3.483` and 15.4 GiB / 46 tok/s →
`$7.643` differ by 2.19×. Solving the formula backwards: `C₁/C₂ = 2.19 × 46/50 = 2.02`.
**The concurrency exactly halved.** 1.4 GiB of extra weights ate enough of the KV-cache
pool to drop one whole stream, and because concurrency is a `floor()` to an integer it
moves in cliffs, not slopes. Same for the A100 row at `$0.754`: 80 GB leaves roughly an
order of magnitude more VRAM for KV cache after weights, so it is ~10× cheaper *per token*
while costing more *per hour*.

**Fix (UI):** add a `Streams` column to the consequence table, between `tok/s` and
`Cost floor`. Without it the cost column reads as arbitrary — which is exactly the reaction
it produced. `DESIGN.md` §3.11 specified the columns as *quality · size · predicted tok/s ·
max context · cost floor*; that list is incomplete and this plan supersedes it.

**Finding (not UI, and not mine to fix silently):** the solver optimises **hourly rate**,
not **cost per token**, and those disagree. In the screenshot the 15.4 GiB variant squeezed
onto a 4090 at one stream for `$7.643`, while the *larger* 15.7 GiB variant did not fit,
fell through to an A100, and landed at `$0.754` — **10× cheaper**. Barely fitting on a
cheap card is the worst outcome available, and `order by usd_per_hour_micro asc … first hit
wins` selects for it. Changing the objective to `min(cost_floor)` across all feasible tiers
is a small edit to one `loop`, but it moves real money and belongs to whoever owns
`resolve_placement` — raising it, not touching it.

What Studio needs from this plan is otherwise only structural:

- move under `(app)` and inherit the shell (§3);
- `StudioNav` becomes the `lg:hidden` state, merged with `ConsoleNav` into one `SubNav` (§5);
- `components/studio/primitives.tsx` already contains a sticky-summary `<aside>`. That is
  `DESIGN.md` §3.9's primitive, built for the second time (`console/primitives.tsx` has
  `Stat` and `LinkCard`). Before the playground rail and the wallet top-up need a third,
  hoist it to `components/ui/` — §3.9's own warning was that getting it wrong three times
  is the avoidable outcome, and we are at two.

---

## 8. Build order

Each phase compiles, ships, and leaves the app usable. Ordered so the riskiest structural
change has the shortest blast radius when it lands.

| Phase | Work | Risk | Blocked on |
|---|---|---|---|
| **A** | Route groups. Move `console/` + `studio/` + `playground/` under `(app)`, split the container out of `app/layout.tsx`, merge the two auth guards, `/` → `/models` with a redirect. **No visual change.** | Medium — touches every route's nesting | — |
| **B** | `MarketingNav` pill + `(marketing)`/`(catalog)` layouts | Low | A |
| **C** | Landing page sections 1–8 | Low | B |
| **D** | `AppShell` sidebar, content header, drawer, `mod+b`, persistence — hand-built per §9 D1 | **High** — can break every authenticated route | A |
| **E** | Facet rail + card rebuild (minus capability chips) | Medium | A |
| **F** | `supports_tools` through `types.ts`/`queries.ts` → capability chips | Low | E |
| **G** | Console quickstart card, sticky table header, hoist the §3.9 sticky-summary primitive out of `components/studio/` | Low | D |
| **H** | Playground: model picker + `[creator]/[slug]` route (L5), platform id (L6), empty state + seed prompts (L4), cold-start line reparented (L3), then the aside + `API view` + unset pill | Medium | D, G |
| **I** | Auth two-panel layout, wordmark, drop the `calc()` magic number (L7) | Low | B (reuses the marketing proof figures) |
| **J** | Studio §7.1: `Streams` column on the consequence table, Revision → `ComboBox` fed by `/api/models/{slug}/refs`, private-price framing + cost-floor default | Low | — (independent of the shell) |

A–C and E–F are independent of each other; D is the serialization point. If only some of
this gets built, **A + D** is the highest-value pair, because it is the split the ask is
actually about.

**Phase H carries a product change, not a restyle.** L5 — the playground naming a model
that may not exist — is the one item here that no amount of shell work fixes, and it is
the thing that made the page read as "strange." If the schedule has to shed work, shed
polish, not H's first three items.

---

## 9. Decisions — settled 2026-08-18


All four were put to the owner and answered. They are decisions now, not options.

**D1 — no HeroUI Pro. Build the shell from the free primitives, extending where they
run out.** `AppLayout`/`Sidebar`/`Navbar` stay in `@heroui-pro/react` and we do not buy
it. `Drawer`, `Disclosure`, `Tooltip`, `Separator`, `ScrollShadow`, `Link` and `Button`
are all in `@heroui/react@3.2.4` and cover most of it; the rail geometry, the collapse
state and the keyboard shortcut are ours to write.

Two constraints on how, so this stays swappable and does not become a second component
library:

- **Mirror HeroUI Pro's public surface.** Same data attributes on the `<aside>`
  (`data-state="expanded|collapsed"`, `data-collapsible`, `data-side`, `data-variant`),
  same slot names (`sidebar__header` / `__content` / `__group` / `__menu-item` /
  `__footer`), same `mod+b`. Adopting the real package later is then a delete, not a
  rewrite.
- **Extend, do not fork.** New primitives go in `components/shell/` as thin compositions
  over HeroUI parts. Nothing in `components/shell/` may restyle a HeroUI component by
  overriding its own classes; it composes, or it uses a token.

Every measurement needed to build it is in §2.1.

**D2 — both themes everywhere,** including marketing. The token system already carries
light and dark correctly; the cost is one verification pass per phase, not a second
design. No route forces a theme.

**D3 — `/` becomes the landing page; the catalog moves to `/models`.** Confirmed. Ship
the redirect with the move.

**D4 — left navigation sidebar, right `aside` for the playground.** Confirmed. The
"right menu" in the original ask is the playground's parameter rail (§5), which is a
separate page-scoped panel, not the navigation.

---

## 10. Verification, per phase

`DESIGN.md` §5's checklist applies unchanged and is not restated. On top of it:

- **No route renders two navs at one breakpoint.** Check 375 / 768 / 1024 / 1440.
- **No horizontal document overflow at 375px** — the check that caught a 37px overflow in
  `site-nav.tsx` and will catch a 240px sidebar rendered too early.
- The sidebar's collapsed state **survives a reload without a flash** of the wrong width.
- Every collapsed rail item is reachable and labelled by keyboard, not hover only.
- `mod+b` does not fire while focus is in a text input.
- The catalog is still server-rendered: view source on `/models` and find model names in
  the HTML.
- `/` redirects nothing that was indexed into a 404.
- No GPU or hardware term anywhere in the diff (`DESIGN.md` §4 item 8), including the new
  landing copy — §4's stat strip is the likeliest place for one to sneak in.
- `npm run check` green.
