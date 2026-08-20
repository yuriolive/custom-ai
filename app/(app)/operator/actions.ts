"use server";

/**
 * Server Actions for the moderation surface (§5.5, GitHub #31).
 *
 * These are thin on purpose. They read a FormData, call one RPC, and revalidate
 * the page. Every rule that matters — who may act, what a suspension requires,
 * which reports a takedown closes — is in migration 20260820002000, enforced by
 * Postgres, and asserted by supabase/tests/08 from the creator's own session.
 * There is no authorization decision in this file to get wrong.
 *
 * They run on the server rather than from the browser because the operator page
 * is a Server Component reading through the same cookie: `revalidatePath` puts
 * the updated queue in the same round trip as the write, and the forms keep
 * working with JavaScript disabled — which for a takedown tool is worth having.
 */

import { revalidatePath } from "next/cache";

import { dismissReport, liftSuspension, suspendListing } from "@/lib/trust/server";
import { SUSPENSION_REASON_MAX_LENGTH } from "@/lib/trust/reports";

import type { OperatorFormState } from "./form-state";

const OPERATOR_PATH = "/operator";

/** UUID shape check, so a malformed id fails here rather than as a Postgres 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

/**
 * Every code the three RPCs can return, in operator-facing words.
 *
 * `not_operator` is called out rather than folded into a generic failure: it is
 * the one outcome that means the page's own gate and the database's have drifted
 * apart, or that the flag was revoked mid-session, and "try again" is the wrong
 * advice for both.
 */
function explain(code: string): string {
  switch (code) {
    case "reason_required":
      return "A suspension needs a reason. It is the only record of why this happened.";
    case "reason_too_long":
      return `Keep the reason under ${SUSPENSION_REASON_MAX_LENGTH} characters.`;
    case "not_found":
      return "That listing or report no longer exists.";
    case "already_suspended":
      return "Already suspended — the original reason was kept.";
    case "not_suspended":
      return "That listing was not suspended.";
    case "already_resolved":
      return "Someone already resolved that report.";
    case "not_operator":
      return "Your operator access was refused. Reload — it may have been revoked.";
    default:
      return "The action did not go through. Please try again.";
  }
}

export async function suspendListingAction(
  _prev: OperatorFormState,
  formData: FormData,
): Promise<OperatorFormState> {
  const modelUuid = field(formData, "modelUuid");
  const reportId = field(formData, "reportId");
  const reason = field(formData, "reason");

  if (!UUID_RE.test(modelUuid)) {
    return { status: "error", message: "That listing id is not valid.", reportId };
  }
  if (reason === "") {
    return { status: "error", message: explain("reason_required"), reportId };
  }

  const outcome = await suspendListing(
    modelUuid,
    reason.slice(0, SUSPENSION_REASON_MAX_LENGTH),
    UUID_RE.test(reportId) ? reportId : null,
  );
  revalidatePath(OPERATOR_PATH);

  if (!outcome.ok) return { status: "error", message: explain(outcome.code), reportId };
  return {
    status: "done",
    message:
      outcome.code === "already_suspended"
        ? explain("already_suspended")
        : "Suspended. It is out of the catalog and the gateway 404s it.",
    reportId,
  };
}

export async function liftSuspensionAction(
  _prev: OperatorFormState,
  formData: FormData,
): Promise<OperatorFormState> {
  const modelUuid = field(formData, "modelUuid");
  const reportId = field(formData, "reportId");

  if (!UUID_RE.test(modelUuid)) {
    return { status: "error", message: "That listing id is not valid.", reportId };
  }

  const outcome = await liftSuspension(modelUuid);
  revalidatePath(OPERATOR_PATH);

  if (!outcome.ok) return { status: "error", message: explain(outcome.code), reportId };
  return {
    status: "done",
    message:
      outcome.code === "not_suspended"
        ? explain("not_suspended")
        : "Suspension lifted. The listing is serving again.",
    reportId,
  };
}

export async function dismissReportAction(
  _prev: OperatorFormState,
  formData: FormData,
): Promise<OperatorFormState> {
  const reportId = field(formData, "reportId");
  const note = field(formData, "note");

  if (!UUID_RE.test(reportId)) {
    return { status: "error", message: "That report id is not valid.", reportId };
  }

  const outcome = await dismissReport(reportId, note === "" ? null : note);
  revalidatePath(OPERATOR_PATH);

  if (!outcome.ok) return { status: "error", message: explain(outcome.code), reportId };
  return { status: "done", message: "Dismissed. The listing was not touched.", reportId };
}
