import Link from "next/link";

import { Section } from "./section";

/**
 * Section 6 — the creator pitch (docs/UI-REDESIGN-PLAN.md §4).
 *
 * A marketplace has two audiences and the landing page has to serve the harder
 * one. A consumer needs to be told the endpoint is compatible; a creator needs to
 * be told what they get paid and what they are not on the hook for. The three
 * steps here are the old `HomeIntro` three-step block turned around — it walked
 * a caller through picking a model; this walks a publisher through shipping one.
 *
 * NO HARDWARE VOCABULARY (DESIGN.md §4 item 8). "The platform picks the
 * hardware" is the claim; naming a GPU tier here would put silicon on a consumer
 * surface, and the one place a creator is shown hardware is Studio's Deployment
 * Plan card, as a read-only result.
 *
 * The 80% is contractual, not aspirational — the schema enforces the split and
 * `usage_transactions` settles it per request. It is stated in three places on
 * this page (hero microcopy, proof strip, here) because it is the reason a
 * creator would choose this over hosting it themselves.
 */

const STEPS: readonly Readonly<{ title: string; body: string }>[] = [
  {
    title: "Paste a Hugging Face repo",
    body: "Studio reads the repo, works out what it is — quantized, full-precision, a fine-tune — and tells you what it will cost to serve before anything is deployed.",
  },
  {
    title: "The platform picks the hardware",
    body: "Not a menu you have to be right about. The solver takes the cheapest option that both fits the model and hits the throughput target, then smoke-tests it before listing.",
  },
  {
    title: "You keep 80% of every bill",
    body: "Settled per request against the caller's prepaid balance — not a revenue share paid out quarterly. Nothing accrues while your model is idle.",
  },
] as const;

export function ForCreators() {
  return (
    <Section
      eyebrow="For creators"
      id="creators"
      lede="If you have published a model, this is a way to charge for it without running a GPU or writing a serving stack."
      title="Ship a model, keep 80% of what it earns"
    >
      <div className="flex flex-col gap-8">
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              className="glass-panel border-border flex flex-col gap-2 rounded-xl border p-5"
              key={step.title}
            >
              <span className="text-accent font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
                Step {index + 1}
              </span>
              <span className="text-base font-medium tracking-[-0.01em]">{step.title}</span>
              <span className="text-muted text-sm leading-[1.55]">{step.body}</span>
            </li>
          ))}
        </ol>

        <Link
          className="text-foreground hover:text-accent focus-visible:ring-accent self-start rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          href="/studio/new"
        >
          Deploy a model →
        </Link>
      </div>
    </Section>
  );
}
