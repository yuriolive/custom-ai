"use client";

import { Alert, ProgressBar } from "@heroui/react";
import { useEffect, useState } from "react";

import { publicEnv } from "@/lib/public-env";

/**
 * Cold-start UX (FR-PLAY-004).
 *
 * This is not decoration. The MVP-0 target model runs on a scale-to-zero
 * llama.cpp worker that takes roughly 100 seconds to wake. A minute and a half
 * of unexplained silence reads as a broken product, so the copy states the
 * cause, the expected wait, and what happens next — and an elapsed counter
 * proves the page is still alive.
 */
export function ColdStartNotice({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const estimate = publicEnv.coldStartEstimateSeconds;
  const overrun = elapsed > estimate;

  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content className="w-full">
        <Alert.Title>Waking the GPU worker</Alert.Title>
        <Alert.Description>
          <span className="block">
            This model scales to zero when idle, so the first request of a session has to start a
            worker and load weights. Expect about <strong>{estimate} seconds</strong>. Once it is
            warm, replies begin in under a second.
          </span>
          <span className="text-muted mt-1 block text-sm tabular-nums">
            {elapsed}s elapsed
            {overrun
              ? " — longer than usual. Still connected; the request has not failed."
              : ` of ~${estimate}s`}
          </span>
        </Alert.Description>

        {/* Sibling of Description, not a child: Alert.Description renders a
            <p>, and a ProgressBar is a <div>. */}
        <ProgressBar
          aria-label="Waking the GPU worker"
          className="mt-3 w-full"
          color="warning"
          isIndeterminate
          size="sm"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      </Alert.Content>
    </Alert>
  );
}
