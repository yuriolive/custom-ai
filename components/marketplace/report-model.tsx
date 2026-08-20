"use client";

/**
 * The report path on the model page (§5.5, GitHub #31).
 *
 * WHY THIS INSERTS DIRECTLY AND HAS NO ROUTE HANDLER. Everything the browser is
 * allowed to do, it does against PostgREST under RLS; the one documented
 * exception is minting an API key, which needs server-side entropy
 * (CONTRACTS.md §Frontend / auth contract, and the header of app/api/keys).
 * Filing a report is not an exception: `model_reports_insert_own` already
 * enforces every rule a handler would have re-implemented — the reporter files
 * as themselves, in `open`, with the resolution columns empty, and only against
 * a listing that is actually in the public catalog. A route handler here would
 * be a second copy of that policy, with a second chance to get it wrong.
 *
 * The INSERT privilege is narrowed to (model_id, reporter_id, reason, details),
 * so this component could not write `status` even if it tried.
 *
 * SIGN-IN IS REQUIRED, and that is a real limitation rather than an oversight: a
 * DMCA notice usually comes from someone who has no account here. An anonymous
 * INSERT into a table is a spam endpoint without a CAPTCHA this repo does not
 * have, so the anonymous path stays the published legal contact on
 * /legal/acceptable-use and an operator files those by hand. The dialog says so
 * rather than hiding the button.
 *
 * `onPress`, never `onClick` (FR-UI-002): HeroUI v3 is React Aria and an
 * `onClick` on one of these components is silently dropped.
 */

import {
  Alert,
  Button,
  Description,
  Label,
  Modal,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
} from "@heroui/react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_COPY,
  REPORT_REASONS,
  type ReportReason,
} from "@/lib/trust/reports";
import { createClient } from "@/lib/supabase/client";

import { appHref } from "./routes";

type Phase = "idle" | "sending" | "sent";

/** Postgres unique-violation: this reporter already has an open report here. */
const UNIQUE_VIOLATION = "23505";
/** RLS refused it — see `explainRefusal`. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * A refusal from the insert policy is deliberately uninformative on the wire,
 * because the policy is deliberately uninformative: it will not tell a caller
 * whether the listing is private, suspended, or fictional (that is the existence
 * oracle it exists to prevent). So the copy names the two things the visitor can
 * actually do something about, and does not guess.
 */
function explainRefusal(code: string | undefined): string {
  if (code === UNIQUE_VIOLATION) {
    return (
      "You have already reported this model and we are still looking at it. " +
      "There is no need to send it again."
    );
  }
  if (code === INSUFFICIENT_PRIVILEGE) {
    return (
      "We could not accept a report for this model. It may have been taken " +
      "down or made private since this page loaded — try reloading."
    );
  }
  return "Something went wrong sending the report. Please try again.";
}

export function ReportModelDialog({
  isOpen,
  modelId,
  modelUuid,
  onOpenChange,
  viewerId,
}: {
  isOpen: boolean;
  /** `creator/slug`, for the copy. Not what the insert uses. */
  modelId: string;
  /** `custom_models.id`. What the insert actually writes. */
  modelUuid: string;
  onOpenChange: (open: boolean) => void;
  /** `null` when signed out — the dialog then explains rather than submits. */
  viewerId: string | null;
}) {
  const [reason, setReason] = useState<ReportReason>("license");
  const [details, setDetails] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset on open, so a previous attempt's text does not reappear — including
  // after a successful send, where leaving it would invite a duplicate.
  useEffect(() => {
    if (!isOpen) return;
    setReason("license");
    setDetails("");
    setPhase("idle");
    setError(null);
  }, [isOpen]);

  async function submit() {
    if (!viewerId || phase === "sending") return;
    setPhase("sending");
    setError(null);

    const supabase = createClient();
    const trimmed = details.trim();
    const { error: insertError } = await supabase.from("model_reports").insert({
      model_id: modelUuid,
      // Written explicitly rather than left to a default: there is no DEFAULT
      // auth.uid() on the column, and the policy requires the two to match.
      reporter_id: viewerId,
      reason,
      details: trimmed === "" ? null : trimmed,
    });

    if (insertError) {
      setError(explainRefusal(insertError.code));
      setPhase("idle");
      return;
    }
    setPhase("sent");
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Report this model</Modal.Heading>
            </Modal.Header>

            <Modal.Body>
              {phase === "sent" ? (
                <Alert status="success">
                  <Alert.Content>
                    <Alert.Title>Report received</Alert.Title>
                    <Alert.Description>
                      Thanks — an operator will review <span className="font-mono">{modelId}</span>.
                      We do not publish who reported what, so you will not see this on the page.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : viewerId === null ? (
                <div className="flex flex-col gap-4">
                  <p className="text-muted text-sm">
                    Reporting a model needs an account, so we can follow up and so the queue cannot
                    be flooded anonymously.
                  </p>
                  <p className="text-muted text-sm">
                    If you would rather not create one — a rights holder sending a copyright notice
                    usually would not — use the contact route on our{" "}
                    <Link className="underline" href="/legal/acceptable-use">
                      acceptable use policy
                    </Link>
                    . It reaches the same people.
                  </p>
                </div>
              ) : (
                <form
                  className="flex flex-col gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <p className="text-muted text-sm">
                    Tell us what is wrong with <span className="font-mono">{modelId}</span>. An
                    operator can take a listing down; the creator cannot put it back.
                  </p>

                  <RadioGroup
                    aria-label="Reason"
                    onChange={(value) => setReason(value as ReportReason)}
                    value={reason}
                  >
                    {REPORT_REASONS.map((key) => (
                      <Radio key={key} value={key}>
                        <Radio.Content>
                          <Radio.Control>
                            <Radio.Indicator />
                          </Radio.Control>
                          <Label>{REPORT_REASON_COPY[key].label}</Label>
                        </Radio.Content>
                        {/* A sibling of `Radio.Content`, per HeroUI's radio
                            structure — the stylesheet indents this slot to line
                            up under the label. */}
                        <span data-slot="description">{REPORT_REASON_COPY[key].note}</span>
                      </Radio>
                    ))}
                  </RadioGroup>

                  <TextField
                    maxLength={REPORT_DETAILS_MAX_LENGTH}
                    onChange={setDetails}
                    value={details}
                  >
                    <Label>What should we know?</Label>
                    <TextArea
                      placeholder="Links, the licence clause, the specific claim — whatever makes the case checkable."
                      rows={4}
                    />
                    <Description>
                      Optional, but a report an operator can verify gets acted on faster.
                    </Description>
                  </TextField>

                  {error ? (
                    <Alert status="danger">
                      <Alert.Content>
                        <Alert.Title>Could not send the report</Alert.Title>
                        <Alert.Description>{error}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}

                  {/* Submit lives in the form so Enter works, and is mirrored in
                      the footer for pointer users. */}
                  <button className="hidden" type="submit">
                    Send
                  </button>
                </form>
              )}
            </Modal.Body>

            <Modal.Footer>
              <Button onPress={() => onOpenChange(false)} variant="ghost">
                {phase === "sent" ? "Close" : "Cancel"}
              </Button>
              {phase === "sent" ? null : viewerId === null ? (
                // A `Link`, not a `Button`: HeroUI v3's Button takes no `href`,
                // and a navigation dressed as a button that intercepts the click
                // loses middle-click and cmd-click. The `next=` sends the
                // reporter back to this model rather than to the console, so
                // signing in to report does not lose the page they were on.
                <Link
                  className="bg-accent text-accent-foreground rounded-md px-4 py-2 text-sm font-medium hover:opacity-90"
                  href={appHref(`/login?next=/models/${modelId}`)}
                >
                  Sign in to report
                </Link>
              ) : (
                <Button
                  isDisabled={phase === "sending"}
                  onPress={() => void submit()}
                  variant="primary"
                >
                  {phase === "sending" ? "Sending…" : "Send report"}
                </Button>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/**
 * The affordance itself: a quiet text button, and the dialog it opens.
 *
 * Quiet on purpose. This is a safety valve, not a call to action — a prominent
 * "Report" next to "Call it" reads as a warning about the listing it sits on, and
 * every listing would carry it.
 */
export function ReportModelButton({
  modelId,
  modelUuid,
  viewerId,
}: {
  modelId: string;
  modelUuid: string;
  viewerId: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button onPress={() => setIsOpen(true)} size="sm" variant="ghost">
        Report this model
      </Button>
      <ReportModelDialog
        isOpen={isOpen}
        modelId={modelId}
        modelUuid={modelUuid}
        onOpenChange={setIsOpen}
        viewerId={viewerId}
      />
    </>
  );
}
