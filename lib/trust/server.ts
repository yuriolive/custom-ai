import "server-only";

/**
 * Server-side reads and writes for the moderation surface (§5.5, GitHub #31).
 *
 * WHAT IS *NOT* IN THIS FILE, and why that is the point: the service-role key.
 *
 * The four operator RPCs in migration 20260820002000 are granted to
 * `authenticated` and each one re-checks `is_platform_operator(auth.uid())`
 * itself, raising 42501 otherwise. So the whole surface runs on the operator's
 * own cookie-bound session. The alternative — a route holding
 * SUPABASE_SERVICE_ROLE_KEY and doing its own authorization — puts the takedown
 * mechanism for every listing on the platform one handler bug away from anyone
 * who can reach the route, and moves the invariant out of the database, where
 * this repo keeps its money and access rules.
 *
 * The `isOperator` check below is therefore NOT the security boundary. It exists
 * so the page can 404 instead of rendering a shell that fails on every action,
 * and so the nav can hide a link nobody else can use. The boundary is in
 * Postgres, and pgTAP asserts it from the creator's own session
 * (supabase/tests/08).
 */

import { createClient, getSessionProfile } from "@/lib/supabase/server";

import { isReportReason, isReportStatus, type ReportReason, type ReportStatus } from "./reports";

/** One row of `operator_report_queue`, in the app's own casing. */
export type QueuedReport = {
  reportId: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  modelUuid: string;
  /** `creator-handle/model-slug` — the addressable id, rebuilt from the join. */
  modelId: string;
  modelDisplayName: string;
  modelVisibility: string;
  /** Non-null => this listing is currently suspended. */
  suspendedAt: string | null;
  suspensionReason: string | null;
  creatorHandle: string;
  /** The creator-level hammer. Shown so an operator does not reach for the
   *  per-listing one on an account that is already fully suspended. */
  creatorIsSuspended: boolean;
};

/**
 * Is the signed-in visitor a platform operator?
 *
 * Goes through `getSessionProfile()` rather than issuing its own
 * `select is_operator`, so the nav's link and this page's gate cannot disagree
 * about who is an operator — a second copy of the read is a second place for the
 * two answers to drift. It reads `profiles.is_operator` on the caller's own row,
 * which `profiles_select_own` already permits, and reports false when signed out,
 * when the profile row is missing, and on error: a failed read must never open
 * the surface.
 */
export async function viewerIsOperator(): Promise<boolean> {
  const profile = await getSessionProfile();
  return profile?.isOperator === true;
}

type RawQueueRow = {
  report_id: string;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  model_id: string;
  model_slug: string;
  model_display_name: string;
  model_visibility: string;
  suspended_at: string | null;
  suspension_reason: string | null;
  creator_id: string;
  creator_handle: string;
  creator_is_suspended: boolean;
};

/**
 * The moderation queue for one status.
 *
 * Goes through the `operator_report_queue` RPC rather than a PostgREST select on
 * `model_reports`, because the queue needs the reported creator's handle and
 * `profiles` has no public SELECT policy — the only anon-readable path to a
 * handle is `creator_public`, which filters `is_suspended = false` and would
 * therefore hide exactly the accounts under moderation.
 *
 * Returns `[]` on error, with the reason logged. A 42501 here means the caller
 * is not an operator, which the page has already established; anything else is a
 * platform fault and an empty queue is a safer thing to render than a crash — as
 * long as the surface never reads empty as "nothing to do", which is why the
 * caller distinguishes the two.
 */
export async function fetchReportQueue(
  status: ReportStatus,
  limit = 100,
): Promise<{ reports: QueuedReport[]; failed: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("operator_report_queue", {
    p_status: status,
    p_limit: limit,
  });

  if (error) {
    console.error("operator report queue failed", { message: error.message, code: error.code });
    return { reports: [], failed: true };
  }

  const rows = (data ?? []) as RawQueueRow[];
  const reports: QueuedReport[] = [];
  for (const row of rows) {
    // The enums are validated rather than cast. They come from Postgres so they
    // cannot be anything else today, but a value added to `report_reason`
    // without a label here would otherwise render as `undefined` in the table.
    if (!isReportReason(row.reason) || !isReportStatus(row.status)) {
      console.error("operator queue row with an unknown enum value", {
        reportId: row.report_id,
        reason: row.reason,
        status: row.status,
      });
      continue;
    }
    reports.push({
      reportId: row.report_id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolutionNote: row.resolution_note,
      modelUuid: row.model_id,
      modelId: `${row.creator_handle}/${row.model_slug}`,
      modelDisplayName: row.model_display_name,
      modelVisibility: row.model_visibility,
      suspendedAt: row.suspended_at,
      suspensionReason: row.suspension_reason,
      creatorHandle: row.creator_handle,
      creatorIsSuspended: row.creator_is_suspended === true,
    });
  }
  return { reports, failed: false };
}

/** What every action below returns: a code the surface renders, never a throw. */
export type ActionOutcome = { ok: boolean; code: string };

type RpcEnvelope = { ok?: boolean; code?: string } | null;

/**
 * Shared tail for the three write RPCs.
 *
 * The RPCs return a `{ok, code}` envelope for the ordinary "nothing to do" cases
 * and RAISE for the authorization failure, so those are the two shapes handled
 * here. A raised 42501 is reported as `not_operator` rather than as a generic
 * failure, because it is the one error that means something specific happened:
 * either the caller's operator flag was revoked mid-session, or the page's own
 * gate has drifted from the database's.
 */
async function callWriteRpc(fn: string, args: Record<string, unknown>): Promise<ActionOutcome> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);

  if (error) {
    console.error("operator action failed", { fn, message: error.message, code: error.code });
    return { ok: false, code: error.code === "42501" ? "not_operator" : "failed" };
  }
  const env = data as RpcEnvelope;
  return { ok: env?.ok === true, code: env?.code ?? "failed" };
}

export function suspendListing(
  modelUuid: string,
  reason: string,
  reportId: string | null,
): Promise<ActionOutcome> {
  return callWriteRpc("suspend_model_listing", {
    p_model_id: modelUuid,
    p_reason: reason,
    p_report_id: reportId,
  });
}

export function liftSuspension(modelUuid: string): Promise<ActionOutcome> {
  return callWriteRpc("lift_model_suspension", { p_model_id: modelUuid });
}

export function dismissReport(reportId: string, note: string | null): Promise<ActionOutcome> {
  return callWriteRpc("dismiss_model_report", { p_report_id: reportId, p_note: note });
}
