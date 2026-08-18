"use client";

/**
 * The body of every `app/console/**\/error.tsx`.
 *
 * Next.js requires each `error.tsx` to be its own client module, so the four of
 * them are thin wrappers over this one component rather than four copies of the
 * same markup.
 *
 * The digest is included when present. In a production build Next replaces a
 * server-thrown message with an opaque digest precisely so a database error
 * string cannot reach the browser; surfacing the digest gives the developer
 * something to quote in a bug report without leaking anything.
 */

import { ErrorPanel } from "./primitives";

export function ConsoleError({
  error,
  reset,
  title,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title: string;
}) {
  const detail = error.digest
    ? `${error.message} (reference ${error.digest})`
    : error.message;

  return <ErrorPanel detail={detail} onRetry={reset} title={title} />;
}
