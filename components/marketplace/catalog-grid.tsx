"use client";

import { Card, EmptyState } from "@heroui/react";
import Link from "next/link";

import { GroupCard } from "./group-card";
import { appHref } from "./routes";
import { catalogHref, EMPTY_QUERY, hasActiveFilters } from "./search-params";
import type { CatalogGroup, CatalogQuery } from "./types";

/**
 * The grid itself (FR-MKT-001): 1 col mobile · 2 tablet · 3 desktop.
 *
 * Keyed on `groupKey`, not on a listing id: the card is a model now, and keying
 * on the quoted listing would remount every card whose quoted listing changed
 * when a filter moved — which is most of them, and which throws away the
 * `Copied` state of any copy button mid-announcement.
 */
export function CatalogGrid({ groups, baseUrl }: { groups: CatalogGroup[]; baseUrl: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <GroupCard baseUrl={baseUrl} group={group} key={group.groupKey} />
      ))}
    </div>
  );
}

/**
 * The two empty states (FR-MKT-011), which are NOT the same state and must not
 * share copy.
 *
 * "Nothing matched your filters" tells the visitor to change something they
 * did; "nothing is published yet" tells them the platform is empty and offers
 * the only useful next step, which is publishing a model. Showing the first when
 * the truth is the second sends someone on a hunt through filters for results
 * that cannot exist.
 */
export function CatalogEmpty({
  query,
  catalogIsEmpty,
}: {
  query: CatalogQuery;
  catalogIsEmpty: boolean;
}) {
  const filtered = hasActiveFilters(query);

  if (catalogIsEmpty || !filtered) {
    return (
      <EmptyState className="py-12">
        <Card className="mx-auto max-w-lg text-center">
          <Card.Header>
            <Card.Title>No public models yet</Card.Title>
            <Card.Description>
              Nothing has been published to the catalog. Every model here is deployed by a creator,
              so the catalog fills up as people ship.
            </Card.Description>
          </Card.Header>
          <Card.Footer className="justify-center">
            {/* An anchor, not a <Button>: HeroUI v3's Button is a React Aria
                <button> with no href, and a real link is what belongs here. */}
            <Link
              className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-9 items-center rounded-field px-4 text-sm font-medium hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
              href="/signup"
            >
              Create an account to deploy one
            </Link>
          </Card.Footer>
        </Card>
      </EmptyState>
    );
  }

  return (
    <EmptyState className="py-12">
      <Card className="mx-auto max-w-lg text-center">
        <Card.Header>
          <Card.Title>No models match these filters</Card.Title>
          <Card.Description>
            {query.q ? (
              <>
                Nothing matched <strong>{query.q}</strong>
                {filtered ? " with the filters you have set" : ""}. Search covers model name, slug,
                description and creator handle.
              </>
            ) : (
              <>
                The catalog has models, but none that clear every filter at once. Try relaxing the
                strictest one — usually minimum speed.
              </>
            )}
          </Card.Description>
        </Card.Header>
        <Card.Footer className="flex-wrap justify-center gap-3">
          <Link
            className="text-accent text-sm font-medium hover:underline"
            href={appHref(catalogHref(EMPTY_QUERY))}
          >
            Clear everything and show all models
          </Link>
        </Card.Footer>
      </Card>
    </EmptyState>
  );
}
