import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import { z } from "zod";

import { encodeChatError, parseGatewayErrorCode } from "@/lib/chat/errors";
import { normalizeModelId } from "@/lib/chat/models";
import { ChatSessionError, ensureChatKey } from "@/lib/chat/session-key";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { createTurnMeter } from "@/lib/turn-metrics";
import type { ChatUIMessage } from "@/lib/types";

/**
 * Chat → gateway proxy (FR-CHAT-005).
 *
 * The difference from `/api/playground` is the only one that matters: this
 * route bills the SIGNED-IN USER. The playground presents `PLATFORM_API_KEY`,
 * so the platform pays for its turns and no `usage_transactions` row names the
 * caller. That is a defensible demo and an indefensible product — a chat open
 * to consumers has to put the tokens on the caller's wallet so the creator's
 * 80% actually reaches them.
 *
 * It gets there without the gateway learning anything new: the browser session
 * holds a real `sk-plat-` key (see `lib/chat/session-key.ts`), and every turn
 * travels the ordinary authenticated path — auth, hold, stream, settle. The
 * plaintext key never reaches the browser's JavaScript; it lives in an httpOnly
 * cookie that only this handler reads.
 *
 * NO INFERENCE PARAMETERS ARE ACCEPTED (FR-CHAT-001). No temperature, no
 * max_tokens, no system prompt — not hidden defaults sent behind the user's
 * back, and not fields the client may set. The playground is where those live.
 * A body carrying them is rejected rather than ignored, so a client that starts
 * sending them fails loudly instead of silently having them dropped.
 *
 * Node runtime, not edge: the gateway's cold-start budget is ~100 s and the
 * edge runtime's shorter ceilings would cut the stream mid-wake.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Cold start can take ~100 s; give the whole turn generous headroom. */
export const maxDuration = 300;

const bodySchema = z
  .object({
    messages: z.array(z.unknown()),
    model: z.string().min(1),
  })
  .strict();

/** OpenAI error envelope, byte-identical to the gateway's (CONTRACTS.md). */
function errorResponse(
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error",
) {
  return Response.json(
    { error: { message, type, param: null, code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  // ── 1. Session. The payer comes from the verified cookie and NOTHING else.
  // A user id in the request body would be a straight "spend someone else's
  // wallet" primitive.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(401, "unauthenticated", "Sign in to use the chat.");
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(400, "invalid_request_body", "Malformed chat request body.");
  }

  const modelId = normalizeModelId(parsed.model);
  if (!modelId) {
    return errorResponse(
      400,
      "invalid_model_format",
      "A model id looks like creator-handle/model-slug.",
    );
  }

  // ── 2. The caller's own inference key. Re-minted transparently when the
  // cookie is missing, malformed, or names a key that has since been revoked.
  let apiKey: string;
  try {
    apiKey = await ensureChatKey(user.id);
  } catch (cause) {
    // Never echo the cause: it can carry a PostgREST message, and this path
    // holds the service role.
    console.error(
      "[chat] could not establish a session key:",
      cause instanceof ChatSessionError ? cause.message : "unknown failure",
    );
    return errorResponse(
      503,
      "chat_session_unavailable",
      "Could not start a chat session. Try again in a moment.",
      "api_error",
    );
  }

  /**
   * The gateway's machine-readable `code`, captured on the way past.
   *
   * The AI SDK surfaces a failure as an `Error` whose message is prose, and
   * prose is the wrong thing to branch on: whether the UI shows a top-up button
   * must not depend on how an error sentence was worded. So the raw envelope is
   * read here — from a clone, leaving the body intact — and the code is handed
   * to the client alongside the message (see `lib/chat/errors.ts`).
   */
  let gatewayErrorCode: string | null = null;

  const gateway = createOpenAICompatible({
    name: "nexus-gateway",
    baseURL: `${serverEnv.gatewayBaseUrl}/v1`,
    apiKey,
    async fetch(input, init) {
      const response = await fetch(input, init);
      if (!response.ok) {
        try {
          gatewayErrorCode = parseGatewayErrorCode(await response.clone().text());
        } catch {
          // A body that cannot be read is not worth failing the request over;
          // the generic presentation covers it.
        }
      }
      return response;
    },
  });

  const modelMessages = await convertToModelMessages(parsed.messages as ChatUIMessage[]);
  const meter = createTurnMeter(Date.now());

  const result = streamText({
    model: gateway.chatModel(modelId),
    messages: modelMessages,
    onError({ error }) {
      // Log the shape, never the request headers or the key.
      console.error("[chat] upstream stream error:", error);
    },
  });

  return result.toUIMessageStreamResponse<ChatUIMessage>({
    messageMetadata: (input) => meter.messageMetadata(input),
    onError(error) {
      const message = error instanceof Error ? error.message : "The gateway request failed.";
      return encodeChatError(gatewayErrorCode ?? "unknown", message);
    },
  });
}
