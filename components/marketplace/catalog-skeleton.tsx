"use client";

import { Card, Separator, Skeleton } from "@heroui/react";

import { PAGE_SIZE } from "./search-params";

/**
 * Loading state for the grid (FR-MKT-005): skeleton cards, never a bare spinner.
 *
 * This is the fallback of the `<Suspense>` boundary around the catalog fetch in
 * `app/page.tsx`, so it appears on the first paint and on every filter change
 * while the server re-queries. A spinner on the primary surface tells the visitor
 * "something is happening"; a skeleton tells them "a grid of cards is arriving",
 * and holds the layout so the page does not jump when it does.
 *
 * The geometry below mirrors `model-card.tsx` block for block — title row with a
 * copy button, two clamped description lines, the figure pair, the quality chip,
 * the separator, the two price rows and the value line, then the footer. A
 * skeleton whose height differs from its replacement is a layout shift with
 * extra steps (DESIGN.md §3.3), so this file changes whenever the card does.
 *
 * `aria-hidden` plus a single live-region label: eight identical skeleton cards
 * announced one by one is noise, not information.
 */
export function CatalogSkeleton({ count = 6 }: { count?: number }) {
  const cards = Array.from({ length: Math.min(count, PAGE_SIZE) });

  return (
    <>
      <p aria-live="polite" className="sr-only" role="status">
        Loading models…
      </p>
      <div aria-hidden="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((_, index) => (
          <Card className="flex h-full flex-col" key={index}>
            <Card.Header className="gap-2">
              {/* Nested rows for the same cascade reason as `model-card.tsx`:
                  HeroUI's unlayered `.card__header` and `.card__content` pin
                  their slots to `flex-direction: column`, so a `flex-row`
                  utility on the slot loses and the placeholder would not match
                  the card it stands in for. */}
              <div className="flex items-start gap-2">
                <Skeleton className="h-5 w-2/3 rounded" />
                <Skeleton className="ml-auto h-8 w-20 shrink-0 rounded" />
              </div>
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
            </Card.Header>

            <Card.Content>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-5 w-12 rounded" />
                    <Skeleton className="h-2.5 w-10 rounded" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-5 w-14 rounded" />
                    <Skeleton className="h-2.5 w-12 rounded" />
                  </div>
                </div>

                <Skeleton className="h-6 w-24 rounded-full" />

                <Separator />

                <div className="flex flex-col gap-2">
                  <Skeleton className="h-2.5 w-24 rounded" />
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-3 w-12 rounded" />
                    <Skeleton className="h-3 w-16 rounded" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-3 w-14 rounded" />
                    <Skeleton className="h-3 w-16 rounded" />
                  </div>
                  <Skeleton className="h-3 w-full rounded" />
                </div>
              </div>
            </Card.Content>

            <Card.Footer className="mt-auto gap-2">
              <Skeleton className="h-8 w-16 rounded" />
              <Skeleton className="h-8 w-20 rounded" />
            </Card.Footer>
          </Card>
        ))}
      </div>
    </>
  );
}
