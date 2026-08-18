"use client";

import { Card, Skeleton } from "@heroui/react";

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
              <Skeleton className="h-4 w-2/3 rounded" />
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
            </Card.Header>
            {/* Nested row for the same reason as `model-card.tsx`: HeroUI's
                unlayered `.card__content` pins the slot to `flex-direction:
                column`, so a `flex-wrap` utility on it yields a stacked column
                and the placeholder would not match the card it stands in for. */}
            <Card.Content>
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-24 rounded-full" />
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
