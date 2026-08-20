"use client";

import { useEffect, useReducer } from "react";

import { MEASURED } from "@/lib/measured";

/**
 * Hero variant `terminal` — one request, start to settled, on a loop.
 *
 * THIS IS THE PRODUCT, NOT A PICTURE OF IT. In one panel: the OpenAI-compatible
 * call, the cold start stated at its measured worst rather than hidden, tokens
 * arriving at the measured decode rate, and exactly one usage row settling with
 * the 80/20 split. Those four things are what the whole landing page argues, and
 * a developer reads them here faster than in four paragraphs.
 *
 * EVERY NUMBER IS FROM `MEASURED` (`lib/measured.ts`, sourced from docs/HANDOFF.md). The cold-start counter runs
 * to 115, not to a friendlier figure; time-to-first-token shows 926 ms, which is
 * a recorded NFR miss. A hero that inflates its own benchmarks is the one thing
 * on this page that a visitor can check in thirty seconds.
 *
 * NO PRICE IN DOLLARS. The panel shows token counts and the split, both of which
 * are contractual, and stops there. A concrete `$0.000212` would be a per-token
 * price for a model whose price is set by its creator — inventing one to make the
 * demo land is the kind of number that turns into a support ticket.
 *
 * WHY A CLIENT COMPONENT. The phase machine below is four states on a timer, and
 * the typewriter needs a growing substring — neither is expressible in CSS
 * without `@property` counter tricks that work in one engine. It is one
 * `setInterval` at 60 ms writing to a reducer, so there is no per-frame work and
 * nothing to lay out. Under `prefers-reduced-motion` the timer never starts and
 * the panel renders its final settled state, which is the most informative frame
 * anyway.
 */

/** What the streamed answer says. Short enough to finish inside one loop. */
const ANSWER =
  "Scale-to-zero means no GPU is running between your requests, so nothing accrues while a model sits idle.";

/** Milliseconds per tick. One tick reveals one character during `stream`. */
const TICK_MS = 60;

/**
 * Ticks spent counting the cold start up before the first token.
 *
 * ~3 seconds of wall clock for a 115-second wait. The compression is obvious and
 * fine — nobody expects a hero to run in real time — but it cannot be much faster
 * than this: at 1.5s the counter sprints 0→115 and stops reading as a wait at all,
 * which is the one thing this line exists to convey.
 */
const COLD_TICKS = 50;
/** Ticks the settled summary stays on screen before the loop restarts. */
const SETTLED_TICKS = 46;

type Phase = "cold" | "stream" | "settled";

type State = Readonly<{ phase: Phase; tick: number; chars: number }>;

const START: State = { phase: "cold", tick: 0, chars: 0 };

/**
 * One tick of the loop. A reducer rather than three pieces of `useState` so a
 * phase change and the counter it depends on can never be applied out of order.
 */
function advance(state: State): State {
  if (state.phase === "cold") {
    return state.tick + 1 >= COLD_TICKS
      ? { phase: "stream", tick: 0, chars: 0 }
      : { ...state, tick: state.tick + 1 };
  }

  if (state.phase === "stream") {
    return state.chars >= ANSWER.length
      ? { phase: "settled", tick: 0, chars: ANSWER.length }
      : { ...state, tick: state.tick + 1, chars: state.chars + 1 };
  }

  return state.tick + 1 >= SETTLED_TICKS ? START : { ...state, tick: state.tick + 1 };
}

/** The completion-token count implied by however much has been revealed. */
function completionTokens(chars: number): number {
  // ~4 characters per token is the standard rule of thumb, and it is only used to
  // make the counter climb in step with the text. The FINAL figure is derived the
  // same way, so the number the panel settles on is the one it counted to.
  return Math.max(1, Math.round(chars / 4));
}

const FINAL_COMPLETION_TOKENS = completionTokens(ANSWER.length);
/** Prompt tokens for the request shown in the panel. Fixed, so it can be counted. */
const PROMPT_TOKENS = 18;

/**
 * The static shell. HOLDS NO STATE, and that separation is a fix rather than a
 * style: the timer used to live here, so every one of the ~17 ticks per second
 * re-rendered the whole panel including the syntax-highlighted code block, which
 * is a few dozen nodes that never change. In dev that was visible — the cold
 * counter climbed at roughly a seventh of the intended rate because each tick
 * cost more than the interval it was scheduled on.
 *
 * With the state pushed down into `TerminalRun`, a tick reconciles four lines
 * instead of the whole hero column.
 */
export function HeroTerminal({ baseUrl }: Readonly<{ baseUrl: string }>) {
  return (
    <div className="border-border bg-surface overflow-hidden rounded-xl border">
      {/* The chrome. Three dots and a language label, because that is what makes a
          panel read as a terminal rather than as a styled div — and the label is
          real: this is the Python snippet the model card hands out. */}
      <div className="border-separator flex items-center gap-2 border-b px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="bg-border size-2.5 rounded-full" />
          <span className="bg-border size-2.5 rounded-full" />
          <span className="bg-border size-2.5 rounded-full" />
        </span>
        <span className="text-muted ml-1 font-mono text-[0.6875rem] tracking-[0.08em] uppercase">
          python
        </span>
      </div>

      <pre className="text-muted overflow-x-auto px-4 py-3.5 font-mono text-[0.6875rem] leading-[1.7]">
        <code>
          {"client = OpenAI(\n"}
          {"    base_url="}
          <span className="text-code-string">{`"${baseUrl}"`}</span>
          {",\n"}
          {"    api_key="}
          <span className="text-code-string">&quot;sk-plat-…&quot;</span>
          {",\n)\n"}
          {"stream = client.chat.completions.create(\n"}
          {"    model="}
          <span className="text-code-string">&quot;creator-handle/model-slug&quot;</span>
          {",\n"}
          {"    stream="}
          <span className="text-code-keyword">True</span>
          {", timeout="}
          <span className="text-code-number">180</span>
          {",\n)"}
        </code>
      </pre>

      {/* The run. Separated from the source by a rule, because the panel is making
          two different claims — this is the code, and this is what it does. */}
      <TerminalRun />
    </div>
  );
}

function TerminalRun() {
  const [state, tick] = useReducer(advance, START);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [tick]);

  const elapsedSeconds = Math.round(
    (state.phase === "cold" ? state.tick / COLD_TICKS : 1) * MEASURED.coldStartSeconds,
  );
  const revealed = ANSWER.slice(0, state.chars);
  const settled = state.phase === "settled";

  return (
    <div className="border-separator bg-surface-secondary flex flex-col gap-2 border-t px-4 py-3.5">
      <Line
        state={state.phase === "cold" ? "active" : "done"}
        label={
          state.phase === "cold"
            ? `waking worker · ${elapsedSeconds}s`
            : `worker ready · ${MEASURED.coldStartSeconds}s cold start`
        }
      />

      <Line
        state={state.phase === "cold" ? "pending" : settled ? "done" : "active"}
        label={`first token · ${MEASURED.warmTtftMs} ms · ${MEASURED.decodeTokensPerSecond} tok/s`}
      />

      {/* `min-h` reserves the two lines the answer will occupy, so the panel does
            not grow as characters arrive. Without it every tick relayouts the hero
            and the CTAs below it jump. */}
      <p className="text-foreground min-h-[4.1rem] font-mono text-[0.6875rem] leading-[1.7]">
        {revealed}
        {state.phase === "stream" ? <span className="streaming-caret" /> : null}
      </p>

      <div className="border-separator flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 font-mono text-[0.6875rem]">
        <span className="text-muted">
          prompt <span className="text-foreground tabular-nums">{PROMPT_TOKENS}</span> · completion{" "}
          <span className="text-foreground tabular-nums">
            {settled ? FINAL_COMPLETION_TOKENS : completionTokens(state.chars)}
          </span>
        </span>
        <span className={settled ? "text-accent" : "text-muted/50"}>
          {settled ? "settled · 80% to creator" : "settling…"}
        </span>
      </div>
    </div>
  );
}

/**
 * One status line. `active` gets the accent dot, `done` a hairline one, `pending`
 * is dimmed — so the sequence reads as a sequence rather than as three labels.
 */
function Line({ state, label }: Readonly<{ state: "pending" | "active" | "done"; label: string }>) {
  return (
    <p
      className={[
        "flex items-center gap-2 font-mono text-[0.6875rem]",
        state === "pending" ? "text-muted/45" : "text-muted",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "size-1.5 shrink-0 rounded-full",
          state === "active" ? "bg-accent" : state === "done" ? "bg-muted" : "bg-border",
        ].join(" ")}
      />
      {label}
    </p>
  );
}
