"use client";

/**
 * The provisioning stepper — FR-STU-007, FR-STU-008.
 *
 * Four stages, driven by `custom_models.status` arriving over Supabase
 * Realtime. THE STEPS ARE NOT ON A TIMER: each one lights up because the row
 * actually reached that status, so a stage that takes 90 seconds looks like a
 * stage that takes 90 seconds rather than like a hang. A stepper that animates
 * on a schedule tells you nothing and lies whenever the backend is slower than
 * the schedule.
 *
 * The status enum IS the stepper — `validating`, `provisioning`,
 * `smoke_testing`, `ready` were already in the schema, so there is no parallel
 * "current step" column to drift out of step with the real state.
 *
 * Realtime is a progress channel, not the source of truth: the POST's response
 * carries the terminal outcome, and this renders it if the websocket never
 * connected. Neither path can leave the stepper stuck on a state the database
 * has moved past.
 */

import { Alert, ProgressBar } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { ModelStatus } from "@/lib/studio/types";

type Stage = {
  key: ModelStatus;
  label: string;
  detail: string;
};

const STAGES: Stage[] = [
  {
    key: "validating",
    label: "Validating",
    detail: "Re-reading the repository and confirming the selected weights exist.",
  },
  {
    key: "provisioning",
    label: "Reserving capacity",
    detail: "Resolving hardware and pointing the model at a serving pool.",
  },
  {
    key: "smoke_testing",
    label: "Measuring speed",
    detail: "Generating real tokens on the worker to measure throughput.",
  },
  { key: "ready", label: "Ready", detail: "The model is callable." },
];

type StepState = "done" | "active" | "pending" | "failed" | "skipped";

/**
 * What one row of the stepper is showing, as a named decision rather than a
 * stack of ternaries. `current` is the stage in progress, or — once `failed` —
 * the stage that broke, so everything before it genuinely did complete.
 */
function stepStateFor(index: number, current: number, failed: boolean, done: boolean): StepState {
  if (failed) {
    if (index === current) return "failed";
    return index > current ? "skipped" : "done";
  }
  if (done || index < current) return "done";
  return index === current ? "active" : "pending";
}

/** How far along a status is, or -1 for the terminal failure states. */
function stageIndex(status: ModelStatus | null): number {
  if (status === null) return 0;
  if (status === "failed" || status === "auth_failed") return -1;
  const index = STAGES.findIndex((s) => s.key === status);
  return index === -1 ? 0 : index;
}

/**
 * Which stage the stepper is pointing at.
 *
 * On failure that is the stage that BROKE: the server's own report when it sent
 * one, and otherwise the last stage Realtime was seen in — a fallback, because
 * two status writes milliseconds apart can leave the client having rendered
 * only the first.
 */
function currentStageIndex(
  failed: boolean,
  reportedStage: number,
  lastActiveStage: number,
  status: ModelStatus | null,
): number {
  if (!failed) return stageIndex(status);
  return reportedStage >= 0 ? reportedStage : lastActiveStage;
}

export function ProvisioningStepper({
  error,
  failedStage,
  modelId,
  onStatusChange,
  status,
}: Readonly<{
  /** Terminal failure from the POST response, when Realtime did not deliver it. */
  error: { message: string; hint: string } | null;
  /**
   * The stage the server says broke. Authoritative — the fallback below infers
   * it from the last status seen over Realtime, which races: two status writes
   * milliseconds apart can leave the client having rendered only the first.
   */
  failedStage: ModelStatus | null;
  /** Null until the row exists — the first stage is optimistic (FR-STU-007). */
  modelId: string | null;
  onStatusChange: (status: ModelStatus) => void;
  status: ModelStatus | null;
}>) {
  const supabase = useMemo(() => createClient(), []);
  const [realtimeDown, setRealtimeDown] = useState(false);

  /**
   * The last stage the row was actually IN before it failed.
   *
   * `status` collapses to `failed` / `auth_failed`, which says a deployment
   * broke but not where — so without this the marker lands on stage 0 and the
   * stepper reports "Validating failed" for a smoke test that failed three
   * stages later. Observed against the live pipeline, not hypothetical.
   */
  const [lastActiveStage, setLastActiveStage] = useState(0);

  useEffect(() => {
    const index = stageIndex(status);
    if (index >= 0) setLastActiveStage(index);
  }, [status]);

  useEffect(() => {
    if (!modelId) return;

    const channel = supabase
      .channel(`studio:model:${modelId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "custom_models",
          filter: `id=eq.${modelId}`,
        },
        (payload) => {
          const next = (payload.new as { status?: unknown }).status;
          if (typeof next === "string") onStatusChange(next as ModelStatus);
        },
      )
      .subscribe((state) => {
        // A channel that never joins must say so, because the alternative is a
        // stepper frozen on stage one while the deployment succeeds behind it.
        // The POST response still resolves the UI; this only sets expectations.
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setRealtimeDown(true);
        if (state === "SUBSCRIBED") setRealtimeDown(false);
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [modelId, onStatusChange, supabase]);

  const failed = status === "failed" || status === "auth_failed";
  const reportedStage = failedStage ? STAGES.findIndex((s) => s.key === failedStage) : -1;
  // On failure, `current` is the stage that broke; everything before it did
  // complete and is shown as such.
  const current = currentStageIndex(failed, reportedStage, lastActiveStage, status);
  const done = status === "ready";

  return (
    <div className="flex flex-col gap-5">
      <ProgressBar
        aria-label="Deployment progress"
        // Terminal either way — complete on success, and pinned full on
        // failure so the bar stops advancing rather than sitting mid-stride.
        value={done || failed ? 100 : ((current + 0.5) / STAGES.length) * 100}
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>

      <ol className="flex flex-col gap-3">
        {STAGES.map((stage, index) => {
          const state = stepStateFor(index, current, failed, done);

          return (
            <li className="flex items-start gap-3" key={stage.key}>
              <StepMarker state={state} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={
                    state === "pending" || state === "skipped"
                      ? "text-muted text-sm"
                      : "text-sm font-medium"
                  }
                >
                  {stage.label}
                </span>
                {state === "active" || state === "failed" ? (
                  <span className="text-muted text-xs">{stage.detail}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {realtimeDown && !done && !failed ? (
        <p className="text-muted text-xs">
          Live updates are unavailable, so these steps may not move until the deployment finishes.
          It is still running — do not close this tab.
        </p>
      ) : null}

      {/* FR-STU-008: the upstream's own error, verbatim, plus what to do. The
          two are separate paragraphs because they are separate things, and the
          verbatim text is the only part an operator can search for. */}
      {failed && error ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Deployment failed</Alert.Title>
            <Alert.Description>
              <span className="block font-mono text-xs break-words">{error.message}</span>
              <span className="mt-2 block text-sm">{error.hint}</span>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </div>
  );
}

function StepMarker({
  state,
}: Readonly<{
  state: "done" | "active" | "pending" | "failed" | "skipped";
}>) {
  if (state === "done") {
    return (
      <span className="bg-success text-success-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full">
        <svg
          aria-hidden="true"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          viewBox="0 0 24 24"
        >
          <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="bg-danger text-danger-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold">
        !
      </span>
    );
  }
  if (state === "active") {
    // A ring, not a spinner. The ProgressBar above already carries motion, and
    // two independent moving things on one card read as two operations.
    return <span className="border-accent mt-0.5 size-5 shrink-0 rounded-full border-2" />;
  }
  return <span className="border-border mt-0.5 size-5 shrink-0 rounded-full border" />;
}
