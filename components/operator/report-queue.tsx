"use client";

/**
 * The moderation queue (§5.5, GitHub #31).
 *
 * A card per report rather than a table row, because acting on one needs a
 * reason field and the reporter's own words, and neither fits a cell. The three
 * actions are `<form action={…}>` with a Server Action, so they work without
 * JavaScript and so the queue refreshes in the same round trip as the write.
 *
 * WHAT IS RENDERED AS TEXT AND WHY IT MATTERS. `details` and `resolutionNote`
 * are untrusted strings — one is typed by whoever filed the report. They go
 * through JSX as children, never through `dangerouslySetInnerHTML`, and never
 * into an `href`. A report body is the one field on this page an attacker fully
 * controls, and the person reading it is the one account that can take listings
 * down.
 *
 * `onPress`, never `onClick` (FR-UI-002) — except on the plain `<button
 * type="submit">` inside each form, which is a DOM element and not a HeroUI/React
 * Aria component. `Button` cannot submit a form it is inside, so the submit
 * controls are real buttons carrying HeroUI's own classes.
 */

import { Alert, Card, Chip, Description, Label, TextArea, TextField } from "@heroui/react";
import Link from "next/link";
import { useActionState, useState } from "react";

import {
  REPORT_REASON_COPY,
  REPORT_STATUSES,
  SUSPENSION_REASON_MAX_LENGTH,
  type ReportStatus,
} from "@/lib/trust/reports";
import type { QueuedReport } from "@/lib/trust/server";

import { appHref } from "@/components/marketplace/routes";

import {
  dismissReportAction,
  liftSuspensionAction,
  suspendListingAction,
} from "@/app/(app)/operator/actions";
import { initialOperatorFormState } from "@/app/(app)/operator/form-state";

const STATUS_LABEL: Record<ReportStatus, string> = {
  open: "Open",
  actioned: "Actioned",
  dismissed: "Dismissed",
};

const SUBMIT_CLASS =
  "border-border hover:bg-surface rounded-md border px-3 py-1.5 text-sm font-medium " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_CLASS =
  "bg-danger text-danger-foreground rounded-md px-3 py-1.5 text-sm font-medium " +
  "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export function ReportQueue({
  activeStatus,
  loadFailed,
  reports,
}: {
  activeStatus: ReportStatus;
  /**
   * The queue read errored, as opposed to returning nothing. The distinction is
   * the whole reason this prop exists: "no reports" and "we could not read the
   * reports" look identical on screen and mean opposite things to the person
   * whose job is to notice a backlog.
   */
  loadFailed: boolean;
  reports: QueuedReport[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Report status" className="flex gap-2">
        {REPORT_STATUSES.map((status) => (
          <Link
            aria-current={status === activeStatus ? "page" : undefined}
            className={
              status === activeStatus
                ? "bg-surface border-border rounded-md border px-3 py-1.5 text-sm font-medium"
                : "text-muted hover:text-foreground rounded-md px-3 py-1.5 text-sm"
            }
            href={appHref(`/operator?status=${status}`)}
            key={status}
          >
            {STATUS_LABEL[status]}
          </Link>
        ))}
      </nav>

      {loadFailed ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Could not read the queue</Alert.Title>
            <Alert.Description>
              This is not an empty queue — the read failed. Reload; if it keeps failing, the reports
              are still there and unactioned.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : reports.length === 0 ? (
        <p className="text-muted text-sm">Nothing {STATUS_LABEL[activeStatus].toLowerCase()}.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {reports.map((report) => (
            <li key={report.reportId}>
              <ReportCard report={report} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: QueuedReport }) {
  const isSuspended = report.suspendedAt !== null;

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">
          {/* `appHref` because `typedRoutes` cannot type a path assembled from a
              database row — the one deliberate cast, in the one place that owns
              it (components/marketplace/routes.ts). */}
          <Link className="font-mono hover:underline" href={appHref(`/models/${report.modelId}`)}>
            {report.modelId}
          </Link>
        </Card.Title>
        <Card.Description>
          {report.modelDisplayName} · reported {new Date(report.createdAt).toLocaleString()}
        </Card.Description>
      </Card.Header>

      <Card.Content className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Chip variant="soft">{REPORT_REASON_COPY[report.reason].operatorLabel}</Chip>
          <Chip color={report.status === "open" ? "warning" : "default"} variant="soft">
            {STATUS_LABEL[report.status]}
          </Chip>
          {isSuspended ? (
            <Chip color="danger" variant="soft">
              Listing suspended
            </Chip>
          ) : null}
          {report.modelVisibility === "private" ? <Chip variant="soft">Private</Chip> : null}
          {/* The creator-level hammer. Shown so nobody reaches for the
              per-listing control on an account that is already fully suspended,
              where it would change nothing a visitor can see. */}
          {report.creatorIsSuspended ? (
            <Chip color="danger" variant="soft">
              Creator account suspended
            </Chip>
          ) : null}
        </div>

        {report.details ? (
          <blockquote className="border-border text-muted border-l-2 pl-3 text-sm whitespace-pre-line">
            {report.details}
          </blockquote>
        ) : (
          <p className="text-muted text-sm italic">No details given.</p>
        )}

        {isSuspended && report.suspensionReason ? (
          <p className="text-sm">
            <span className="text-muted">Standing suspension reason: </span>
            {report.suspensionReason}
          </p>
        ) : null}

        {report.resolvedAt ? (
          <p className="text-muted text-sm">
            Resolved {new Date(report.resolvedAt).toLocaleString()}
            {report.resolutionNote ? ` — ${report.resolutionNote}` : ""}
          </p>
        ) : null}
      </Card.Content>

      <Card.Footer className="flex flex-col gap-4">
        {isSuspended ? <LiftForm report={report} /> : <SuspendForm report={report} />}
        {report.status === "open" ? <DismissForm report={report} /> : null}
      </Card.Footer>
    </Card>
  );
}

// ─── Suspend ─────────────────────────────────────────────────────────────────

function SuspendForm({ report }: { report: QueuedReport }) {
  const [state, action, isPending] = useActionState(suspendListingAction, initialOperatorFormState);
  const [reason, setReason] = useState("");

  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="modelUuid" type="hidden" value={report.modelUuid} />
      <input name="reportId" type="hidden" value={report.reportId} />

      {/* Controlled AND named: the state drives `disabled` on the submit, and the
          name is what a JavaScript-disabled submit actually sends. */}
      <TextField
        isRequired
        maxLength={SUSPENSION_REASON_MAX_LENGTH}
        name="reason"
        onChange={setReason}
        value={reason}
      >
        <Label>Suspension reason</Label>
        <TextArea
          placeholder="DMCA notice 2026-08-20, ref #… — what a support reply would have to say."
          rows={2}
        />
        <Description>
          Stored on the listing. It is the only record of why this happened, and the creator can
          read it, so write it for them.
        </Description>
      </TextField>

      <Outcome reportId={report.reportId} state={state} />

      <div className="flex items-center gap-3">
        <button className={DANGER_CLASS} disabled={isPending || reason.trim() === ""} type="submit">
          {isPending ? "Suspending…" : "Suspend listing"}
        </button>
        <span className="text-muted text-xs">
          Closes every open report on this listing, not just this one.
        </span>
      </div>
    </form>
  );
}

// ─── Lift ────────────────────────────────────────────────────────────────────

function LiftForm({ report }: { report: QueuedReport }) {
  const [state, action, isPending] = useActionState(liftSuspensionAction, initialOperatorFormState);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="modelUuid" type="hidden" value={report.modelUuid} />
      <input name="reportId" type="hidden" value={report.reportId} />

      <Outcome reportId={report.reportId} state={state} />

      <div className="flex items-center gap-3">
        <button className={SUBMIT_CLASS} disabled={isPending} type="submit">
          {isPending ? "Lifting…" : "Lift suspension"}
        </button>
        <span className="text-muted text-xs">
          Puts it back in the catalog and back on the gateway. Resolved reports stay resolved.
        </span>
      </div>
    </form>
  );
}

// ─── Dismiss ─────────────────────────────────────────────────────────────────

function DismissForm({ report }: { report: QueuedReport }) {
  const [state, action, isPending] = useActionState(dismissReportAction, initialOperatorFormState);
  const [note, setNote] = useState("");

  return (
    <form action={action} className="border-border flex flex-col gap-3 border-t pt-4">
      <input name="reportId" type="hidden" value={report.reportId} />

      <TextField maxLength={2000} name="note" onChange={setNote} value={note}>
        <Label>Dismissal note</Label>
        <TextArea placeholder="Optional — why this report needed no action." rows={2} />
      </TextField>

      <Outcome reportId={report.reportId} state={state} />

      <div className="flex items-center gap-3">
        <button className={SUBMIT_CLASS} disabled={isPending} type="submit">
          {isPending ? "Dismissing…" : "Dismiss report"}
        </button>
        <span className="text-muted text-xs">Closes this report. The listing is untouched.</span>
      </div>
    </form>
  );
}

// ─── Shared outcome banner ───────────────────────────────────────────────────

/**
 * `state.reportId` is compared rather than trusted: three forms on a card each
 * hold their own `useActionState`, and a stale state from a re-render must not
 * show one report's outcome under another.
 */
function Outcome({
  reportId,
  state,
}: {
  reportId: string;
  state: { status: string; message?: string; reportId?: string };
}) {
  if (state.status === "idle" || !state.message) return null;
  if (state.reportId && state.reportId !== reportId) return null;

  return (
    <Alert status={state.status === "error" ? "danger" : "success"}>
      <Alert.Content>
        <Alert.Description>{state.message}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
