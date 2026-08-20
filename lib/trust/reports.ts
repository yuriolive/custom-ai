/**
 * The report taxonomy, shared by the report dialog and the operator queue.
 *
 * The enum values here are `public.report_reason` in
 * supabase/migrations/20260820002000. They are a CLOSED vocabulary on purpose:
 * the reason decides which process answers a report — a copyright claim has a
 * statutory clock, an acceptable-use complaint does not — and an open text field
 * makes that ungroupable. `other` exists so nobody is forced to mis-file.
 *
 * The labels are written for the person filing, not for the person triaging:
 * "The licence does not allow this" is a sentence a creator recognises,
 * "license" is a database value. The operator surface shows the same list with
 * `OPERATOR_LABEL`, which is terse because it renders in a table.
 *
 * No runtime dependency on anything: this module is imported by a Server
 * Component and by a `"use client"` module, and it must stay safe in both.
 */

export const REPORT_REASONS = [
  "license",
  "copyright",
  "acceptable_use",
  "security",
  "impersonation",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Details is bounded by a CHECK; the field stops at the same number. */
export const REPORT_DETAILS_MAX_LENGTH = 4000;

/** Reason a suspension needs, bounded by the same CHECK as suspension_reason. */
export const SUSPENSION_REASON_MAX_LENGTH = 2000;

type ReasonCopy = {
  /** What the reporter picks. */
  label: string;
  /** One line under it, so the six options are actually distinguishable. */
  note: string;
  /** What the operator queue shows in a table cell. */
  operatorLabel: string;
};

export const REPORT_REASON_COPY: Record<ReportReason, ReasonCopy> = {
  license: {
    label: "The licence does not allow this",
    note: "The weights' licence forbids hosting them, or forbids hosting them commercially.",
    operatorLabel: "Licence",
  },
  copyright: {
    label: "Copyright or ownership claim",
    note: "You hold rights in these weights, or in the name they are published under.",
    operatorLabel: "Copyright",
  },
  acceptable_use: {
    label: "Breaks the acceptable use policy",
    note: "The model or its description carries content the policy forbids.",
    operatorLabel: "Acceptable use",
  },
  security: {
    label: "Malicious or unsafe",
    note: "The repository ships something harmful, or the model behaves maliciously.",
    operatorLabel: "Security",
  },
  impersonation: {
    label: "Impersonates someone else",
    note: "It presents itself as a model, org or person it is not.",
    operatorLabel: "Impersonation",
  },
  other: {
    label: "Something else",
    note: "Tell us what is wrong and we will route it.",
    operatorLabel: "Other",
  },
};

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}
