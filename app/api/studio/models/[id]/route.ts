/**
 * DELETE /api/studio/models/[id] — FR-STU-010, FR-DEP-014.
 *
 * `custom_models` has NO client DELETE policy, by design, so this is the only
 * way a model is removed. Three things have to happen and two of them are not
 * expressible as a client statement:
 *
 *   1. SOFT delete. `usage_transactions.model_id` references this row, and a
 *      hard delete would either cascade away settled billing history or fail
 *      on the constraint. Neither is acceptable: a caller's ledger must remain
 *      readable after a creator withdraws a model.
 *   2. The Vault secret is destroyed in the same operation (FR-DEP-014).
 *      Leaving it behind leaves a live credential over the creator's entire
 *      private HF namespace with nothing referencing it.
 *   3. The row stops being servable immediately — `gateway_resolve` reads
 *      `deleted_at` and the gateway maps a non-null value to 404.
 *
 * There is no upstream resource to tear down. On Modal a model is a set of
 * class parameters selecting an autoscaled pool, not a created resource
 * (tools/modal/README.md), so nothing is orphaned by its absence.
 *
 * The AlertDialog that requires the slug to be typed lives in the browser and
 * is a guard against a mis-click, not a security control. The security control
 * is `.eq("user_id", user.id)` below.
 */

import { createAdminClient } from "@/lib/studio/server/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return Response.json(
    { ok: false, code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) {
    return errorResponse(401, "unauthenticated", "Sign in to delete a model.");
  }

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return errorResponse(400, "invalid_id", "That is not a model id.");
  }

  const admin = createAdminClient();

  // Ownership is re-checked here rather than trusted from the URL: `admin`
  // bypasses RLS, so without this filter any signed-in user could delete any
  // model by id. The confirmation typed in the dialog proves intent, not title.
  const { data: model, error: readError } = await admin
    .from("custom_models")
    .select("id, slug, hf_token_secret_id, deleted_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (readError) {
    console.error("[studio] delete lookup failed:", readError.message);
    return errorResponse(500, "internal_error", "Could not look up that model.");
  }
  // Not-found and not-yours are the same response on purpose: distinguishing
  // them turns this into an oracle for which model ids exist.
  if (!model) {
    return errorResponse(404, "not_found", "No such model.");
  }
  if (model.deleted_at) {
    // Idempotent: a double submit must not overwrite the original timestamp.
    return Response.json(
      { ok: true, alreadyDeleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const { error: updateError } = await admin
    .from("custom_models")
    .update({
      deleted_at: new Date().toISOString(),
      status: "deleted",
      // Unlisted from the catalog in the same statement, so a model is never
      // briefly visible-but-deleted between two writes.
      visibility: "private",
      // Released so the slug can be reused by its owner, and so no stale
      // reference survives the row.
      upstream_endpoint_ref: null,
      hf_token_secret_id: null,
    })
    .eq("id", model.id)
    .is("deleted_at", null);

  if (updateError) {
    console.error("[studio] delete failed:", updateError.message);
    return errorResponse(500, "internal_error", "Could not delete that model.");
  }

  // AFTER the row no longer references it, so a failure here cannot strand a
  // model pointing at a secret that no longer exists. The reverse order would
  // leave a `requires_hf_auth` row whose token is gone — a model that fails at
  // its next cold start with no way to tell why.
  if (model.hf_token_secret_id) {
    const { error: vaultError } = await admin.rpc("studio_destroy_hf_token", {
      p_secret_id: model.hf_token_secret_id,
    });
    if (vaultError) {
      // The model IS deleted; this is a cleanup failure, and reporting the
      // delete as failed would be wrong. It is loud in the log because a
      // surviving secret is a live credential.
      console.error(
        `[studio] model ${model.id} deleted but its Vault secret was not destroyed:`,
        vaultError.message,
      );
    }
  }

  return Response.json(
    { ok: true, slug: model.slug },
    { headers: { "Cache-Control": "no-store" } },
  );
}
