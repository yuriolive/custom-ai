"use client";

import { Card, Separator, Skeleton } from "@heroui/react";

import { PAGE_SIZE } from "./search-params";

/**
 * Loading state for the catalog (FR-MKT-005): skeleton cards, never a bare
 * spinner.
 *
 * This is the fallback of the `<Suspense>` boundary around the catalog fetch in
 * `app/(catalog)/models/page.tsx`, so it appears on the first paint and on every
 * filter change while the server re-queries. A spinner on the primary surface
 * tells the visitor "something is happening"; a skeleton tells them "a grid of
 * cards is arriving", and holds the layout so the page does not jump when it does.
 *
 * IT STANDS IN FOR THE WHOLE RESULTS REGION, not just the grid. Since the rail
 * and the category tabs gained counts (#26) they live inside the boundary too, so
 * a skeleton that covered only the cards would collapse the two-column layout for
 * the duration of every filter change — a 220px horizontal jump on each click,
 * which is a bigger shift than the one this file exists to prevent.
 *
 * The card geometry below mirrors `group-card.tsx` block for block — title row
 * with the listing count, the provenance line, two clamped description lines, the
 * figure TRIO, the chip row, the separator, the two price rows and the value line,
 * the mono id row with its copy button, then the footer. A skeleton whose height
 * differs from its replacement is a layout shift with extra steps (DESIGN.md
 * §3.3), so this file changes whenever the card does.
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
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 lg:grid lg:grid-cols-[220px_1fr] lg:items-start lg:gap-8"
      >
        {/* The rail's placeholder. Five facet headings at the same height as a
            collapsed `Disclosure.Trigger`, so the column is the right width and
            roughly the right height before the real rail arrives. */}
        <div className="hidden flex-col gap-1 lg:flex">
          {Array.from({ length: 5 }).map((_, index) => (
            <div className="border-border flex items-center gap-2 border-b py-2" key={index}>
              <Skeleton className="h-3 w-16 rounded" />
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* The tab strip: `h-8` pills matching `CategoryTabs`. */}
          <div className="flex gap-1 py-1">
            <Skeleton className="h-8 w-16 rounded-field" />
            <Skeleton className="h-8 w-20 rounded-field" />
            <Skeleton className="h-8 w-24 rounded-field" />
          </div>

          {/* The result count line. */}
          <Skeleton className="h-4 w-20 rounded" />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((_, index) => (
              <Card className="flex h-full flex-col" key={index}>
                <Card.Header className="gap-2">
                  {/* Nested rows for the same cascade reason as
                      `group-card.tsx`: HeroUI's unlayered `.card__header` and
                      `.card__content` pin their slots to
                      `flex-direction: column`, so a `flex-row` utility on the
                      slot loses and the placeholder would not match the card it
                      stands in for. */}
                  <div className="flex items-start gap-2">
                    <Skeleton className="h-5 w-1/2 rounded" />
                    <Skeleton className="ml-auto h-4 w-16 shrink-0 rounded" />
                  </div>
                  {/* The provenance line. */}
                  <Skeleton className="h-3 w-3/4 rounded" />
                  <Skeleton className="h-3 w-full rounded" />
                  <Skeleton className="h-3 w-4/5 rounded" />
                </Card.Header>

                <Card.Content>
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-3 gap-2">
                      {Array.from({ length: 3 }).map((__, figure) => (
                        <div className="flex flex-col gap-1" key={figure}>
                          <Skeleton className="h-5 w-10 rounded" />
                          <Skeleton className="h-2 w-12 rounded" />
                        </div>
                      ))}
                    </div>

                    <div className="flex gap-1.5">
                      <Skeleton className="h-6 w-20 rounded-full" />
                      <Skeleton className="h-6 w-14 rounded-full" />
                      <Skeleton className="h-6 w-16 rounded-full" />
                    </div>

                    <Separator />

                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-2.5 w-32 rounded" />
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

                    {/* The mono model id and its copy button. */}
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-3 flex-1 rounded" />
                      <Skeleton className="h-8 w-20 shrink-0 rounded" />
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
        </div>
      </div>
    </>
  );
}
