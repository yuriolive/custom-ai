import type { Metadata } from "next";

import { ChatApp } from "@/components/chat/chat-app";
import { fetchChatModels } from "@/components/marketplace/queries";
import { pickInitialModel } from "@/lib/chat/models";
import { createClient } from "@/lib/supabase/server";

/**
 * `/chat` — the consumer surface (FR-CHAT-001…009).
 *
 * The playground is a developer instrument: temperature, max tokens and a
 * system prompt sit beside the transcript because someone about to write code
 * against the API needs to feel what those do. This page is for the person who
 * has never heard of top-p, and it asks them for exactly one decision — which
 * model — because that is the only one that changes the answer they get.
 *
 * A Server Component: the catalog read happens here, and `@heroui/react` is
 * client-only, so everything interactive lives inside `<ChatApp>`.
 *
 * Route protection is in `lib/supabase/middleware.ts`. Signing in is required
 * (FR-CHAT-009) — every turn wakes a metered GPU, and an anonymous turn would
 * be one the platform pays for with no wallet to charge and no creator to pay.
 */
export const metadata: Metadata = {
  title: "Chat — Nexus Inference",
  description:
    "Pick a model from the catalog and start talking. Billed per token from your wallet; " +
    "conversations stay in your browser.",
};

type SearchParams = Promise<{ model?: string | string[] }>;

export default async function ChatPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const supabase = await createClient();
  const models = await fetchChatModels(supabase);

  const { model } = await searchParams;
  // `?model=a&model=b` is a malformed link, not a request for two models. The
  // first wins rather than the whole page failing.
  const requested = Array.isArray(model) ? model[0] : model;

  const { model: initial, unavailableModelId } = pickInitialModel(models, requested);

  return (
    <ChatApp
      initialModelId={initial?.modelId ?? null}
      models={models}
      unavailableModelId={unavailableModelId}
    />
  );
}
