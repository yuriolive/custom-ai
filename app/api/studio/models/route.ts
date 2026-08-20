/**
 * POST /api/studio/models — deploy a model (FR-STU-007, FR-STU-008).
 *
 * WHY A ROUTE AND NOT A DIRECT INSERT. `custom_models` does have a creator
 * INSERT policy, so this looks at first like something CONTRACTS.md would send
 * straight to PostgREST. It is not, and the policy itself says so: it requires
 * `gpu_tier_id IS NULL AND max_concurrent_streams IS NULL AND
 * placement_rationale IS NULL`. Solver output is not creator-writable, on
 * purpose — a creator who could write `predicted_tokens_per_second` could
 * publish a throughput claim no hardware ever met. The row that carries a
 * placement therefore has to be written by something holding the service role,
 * after that placement has been resolved server-side.
 *
 * The response arrives when the pipeline is finished. The stepper does not wait
 * for it: it subscribes to the row over Realtime and watches the status column
 * move. This response is the terminal answer and the fallback for a browser
 * whose websocket never connected.
 */

import { runDeployment } from "@/lib/studio/server/deploy";
import { createAdminClient } from "@/lib/studio/server/admin";
import type { DeployRequest } from "@/lib/studio/types";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The smoke test generates real tokens on a worker that may be cold, and the
 * MVP's own target model has a ~101 s cold-start budget (PRD §4.3.3.2a). The
 * pipeline's internal timeout is derived per-model from `cold_start_budget_s`;
 * this is the outer bound.
 */
export const maxDuration = 300;

/** Price ceiling from the column CHECK: 0 … 1e9 micro-USD per 1M tokens. */
const MAX_PRICE_MICRO = 1_000_000_000;

function errorResponse(status: number, code: string, message: string, hint = "") {
  return Response.json(
    { ok: false, code, message, hint },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Body validation.
 *
 * Money arrives as an INTEGER count of micro-USD and is checked to be one here.
 * A float in this field would reach a BIGINT column and be rejected by
 * Postgres, which is the loud failure — but it would be rejected AFTER the
 * probe, the solver and the Vault write, so it is caught before any of that.
 */
function parseBody(
  raw: unknown,
): { ok: true; value: DeployRequest } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "Expected a JSON object." };
  }
  const b = raw as Record<string, unknown>;

  const text = (key: string, max: number, required: boolean) => {
    const v = b[key];
    if (typeof v !== "string") return required ? null : "";
    const trimmed = v.trim();
    if (required && trimmed.length === 0) return null;
    return trimmed.slice(0, max);
  };

  const int = (key: string, min: number, max: number) => {
    const v = b[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
    return v;
  };

  const hfRepoSlug = text("hfRepoSlug", 200, true);
  const displayName = text("displayName", 100, true);
  if (hfRepoSlug === null) return { ok: false, message: "A Hugging Face repository is required." };
  if (displayName === null) return { ok: false, message: "A display name is required." };

  const variantId = text("variantId", 120, true);
  if (variantId === null) return { ok: false, message: "A quality variant must be selected." };

  const contextLength = int("contextLength", 256, 4_194_304);
  if (contextLength === null) return { ok: false, message: "The context window is out of range." };

  const targetTokensPerSecond = int("targetTokensPerSecond", 1, 10_000);
  if (targetTokensPerSecond === null) {
    return { ok: false, message: "The minimum speed is out of range." };
  }

  const pricePromptMicro = int("pricePromptMicro", 0, MAX_PRICE_MICRO);
  const priceCompletionMicro = int("priceCompletionMicro", 0, MAX_PRICE_MICRO);
  if (pricePromptMicro === null || priceCompletionMicro === null) {
    return {
      ok: false,
      message: "Prices must be whole micro-USD per 1M tokens, between 0 and 1,000,000,000.",
    };
  }

  const hfToken = typeof b.hfToken === "string" ? b.hfToken.trim() : "";

  return {
    ok: true,
    value: {
      hfRepoSlug,
      hfRevision: text("hfRevision", 100, false) || "main",
      displayName,
      description: text("description", 2000, false) ?? "",
      ...(hfToken ? { hfToken } : {}),
      variantId,
      contextLength,
      targetTokensPerSecond,
      pricePromptMicro,
      priceCompletionMicro,
      isPublic: b.isPublic !== false,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) {
    return errorResponse(401, "unauthenticated", "Sign in to deploy a model.");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid_request_body", "Expected a JSON body.");
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    return errorResponse(400, "invalid_request", parsed.message);
  }

  const admin = createAdminClient();

  try {
    // `user.id` comes from the verified session cookie. It is never read from
    // the body — `admin` bypasses RLS, so a body-supplied owner would let any
    // signed-in user create models in somebody else's namespace.
    const outcome = await runDeployment(admin, session, user.id, parsed.value);

    if (!outcome.ok) {
      return Response.json(outcome, {
        // 200 with ok:false, deliberately. Every one of these is a state the
        // form renders (a gated repo, an infeasible plan, a worker that would
        // not start) and several leave a row behind in `failed` that the
        // creator can see and act on. An HTTP error code would make the client
        // treat a real, recorded outcome as a transport failure.
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return Response.json(outcome, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    // The detail describes internal topology, so it goes to the server log and
    // the client gets a flat message.
    console.error("[studio] deploy failed:", cause instanceof Error ? cause.message : cause);
    return errorResponse(
      500,
      "internal_error",
      "The deployment could not be started.",
      "This is a platform-side failure. Nothing was charged and no endpoint was created.",
    );
  }
}
