"use client";

import { ConsoleError } from "@/components/console/console-error";

export default function UsageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ConsoleError error={error} reset={reset} title="Could not load your usage" />;
}
