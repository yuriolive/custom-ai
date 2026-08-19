"use client";

import { ConsoleError } from "@/components/console/console-error";

/**
 * Route-level error boundary for /studio/**. Reuses the console's boundary
 * rather than cloning it — the two surfaces fail the same way and a second copy
 * would drift.
 */
export default function StudioError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  return <ConsoleError error={error} reset={reset} title="Creator Studio could not load" />;
}
