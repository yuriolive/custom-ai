import { Chat } from "@/components/playground/chat";
import { publicEnv } from "@/lib/public-env";

export const metadata = {
  title: "Playground — Nexus Inference",
};

/**
 * MVP-0 playground.
 *
 * The PRD routes this at /playground/[creator]/[slug]; MVP-0 has exactly one
 * manually provisioned endpoint, so the model comes from
 * NEXT_PUBLIC_DEFAULT_MODEL and the dynamic segments are deferred along with
 * the marketplace that would link to them.
 *
 * This page stays a server component so it can export `metadata`; every HeroUI
 * surface lives inside <Chat>, which is a client component (the @heroui/react
 * barrel is client-only).
 */
export default function PlaygroundPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">Playground</h1>
        <code className="text-muted text-sm">{publicEnv.defaultModel}</code>
      </div>

      <Chat model={publicEnv.defaultModel} />
    </div>
  );
}
