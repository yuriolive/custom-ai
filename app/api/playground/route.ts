import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { emptyTurnMetrics, type PlaygroundUIMessage, type TurnMetrics } from "@/lib/types";

/**
 * Playground → gateway proxy (FR-PLAY-001).
 *
 * The browser never talks to the gateway directly and never sees a platform
 * key. This handler holds the credential and forwards an OpenAI-compatible
 * request to `${GATEWAY_BASE_URL}/v1/chat/completions`.
 *
 * Node runtime, not edge: the gateway's cold-start budget is ~100 s and the
 * edge runtime's shorter ceilings would cut the stream mid-wake.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Cold start can take ~100 s; give the whole turn generous headroom. */
export const maxDuration = 300;

const bodySchema = z.object({
  messages: z.array(z.unknown()),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  systemPrompt: z.string().max(8_000).optional(),
});

/** OpenAI error envelope, byte-identical to the gateway's (CONTRACTS.md). */
function errorResponse(
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error",
) {
  return Response.json({ error: { message, type, param: null, code } }, { status });
}

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(400, "invalid_request_body", "Malformed playground request body.");
  }

  const { messages, model, temperature, maxTokens, systemPrompt } = parsed;

  let apiKey: string;
  try {
    apiKey = serverEnv.platformApiKey;
  } catch {
    // Never echo the variable's value — only the fact that it is unset.
    return errorResponse(
      503,
      "gateway_not_configured",
      "PLATFORM_API_KEY is not set. Copy .env.example to .env.local and fill it in.",
      "api_error",
    );
  }

  const gateway = createOpenAICompatible({
    name: "nexus-gateway",
    baseURL: `${serverEnv.gatewayBaseUrl}/v1`,
    apiKey,
  });

  const modelMessages = await convertToModelMessages(messages as PlaygroundUIMessage[]);

  const startedAt = Date.now();
  let ttftMs: number | null = null;
  let firstTokenAt: number | null = null;
  let completionTokens = 0;

  const result = streamText({
    model: gateway.chatModel(model ?? "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"),
    system: systemPrompt || undefined,
    messages: modelMessages,
    temperature,
    maxOutputTokens: maxTokens,
    onError({ error }) {
      // Log the shape, never the request headers or the key.
      console.error("[playground] upstream stream error:", error);
    },
  });

  return result.toUIMessageStreamResponse<PlaygroundUIMessage>({
    /**
     * Per-turn metering rides along as UI message metadata (FR-PLAY-005) so the
     * cost footer renders from the same object as the message.
     *
     * TTFT is measured here, at the proxy — the only place that sees both the
     * request start and the first byte. Cost is left null until the gateway
     * reports settlement; the shape is wired now so nothing downstream changes
     * when it lands.
     */
    messageMetadata({ part }): TurnMetrics | undefined {
      if (part.type === "start") {
        return { ...emptyTurnMetrics };
      }

      if (part.type === "text-delta") {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          ttftMs = firstTokenAt - startedAt;
          return {
            ...emptyTurnMetrics,
            ttftMs,
            // A cold start is the honest read of a multi-second TTFT on a
            // scale-to-zero worker.
            coldStart: ttftMs > 10_000,
          };
        }
        completionTokens += 1; // rough live counter; replaced at finish
        return undefined;
      }

      if (part.type === "finish") {
        const elapsedStreamingMs = firstTokenAt ? Date.now() - firstTokenAt : null;
        const inputTokens = part.totalUsage.inputTokens ?? null;
        const outputTokens = part.totalUsage.outputTokens ?? null;

        // llama.cpp does not guarantee usage on the final chunk
        // (CONTRACTS.md §Upstream), so fall back to the streamed delta count
        // and label it honestly rather than showing a confident zero.
        const usageSource: TurnMetrics["usageSource"] =
          outputTokens != null ? "upstream" : "estimated";
        const completion = outputTokens ?? completionTokens;

        return {
          promptTokens: inputTokens,
          completionTokens: completion,
          // TODO(gateway): populate from the settlement response once
          // deduct_token_cost surfaces cost_micro_usd through the gateway.
          costMicroUsd: null,
          ttftMs,
          tokensPerSecond:
            elapsedStreamingMs && elapsedStreamingMs > 0 && completion > 0
              ? (completion / elapsedStreamingMs) * 1_000
              : null,
          coldStart: ttftMs != null ? ttftMs > 10_000 : null,
          usageSource,
        };
      }

      return undefined;
    },
    onError(error) {
      // Message shown to the user in the inline danger Alert (FR-PLAY-009).
      return error instanceof Error ? error.message : "The gateway request failed.";
    },
  });
}
