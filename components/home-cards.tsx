"use client";

import { Card, Chip } from "@heroui/react";
import Link from "next/link";

import { publicEnv } from "@/lib/public-env";

/**
 * NOTE: this is a client component on purpose.
 *
 * The `@heroui/react` barrel pulls in `react-aria-components`, whose Toast
 * export is marked `client-only`. Importing anything from `@heroui/react`
 * inside a React Server Component therefore fails the build. Every HeroUI
 * surface in this app lives behind a `"use client"` boundary.
 */
export function HomeCards() {
  return (
    <>
      <Chip color="warning" size="sm" variant="soft">
        MVP-0 scaffold
      </Chip>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <Card.Header>
            <Card.Title>Playground</Card.Title>
            <Card.Description>
              Chat against the gateway with live per-turn metering.
            </Card.Description>
          </Card.Header>
          <Card.Content className="text-muted text-sm">
            Streams from{" "}
            <code className="text-foreground">{publicEnv.defaultModel}</code>.
            The worker scales to zero, so the first request of a session pays a
            cold start of roughly {publicEnv.coldStartEstimateSeconds} seconds.
          </Card.Content>
          <Card.Footer>
            <Link
              className="text-accent text-sm font-medium hover:underline"
              href="/playground"
            >
              Open the playground →
            </Link>
          </Card.Footer>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Not built yet</Card.Title>
            <Card.Description>Deliberately out of MVP-0 scope.</Card.Description>
          </Card.Header>
          <Card.Content>
            <ul className="text-muted flex flex-col gap-1 text-sm">
              <li>Public marketplace (§4.1.1)</li>
              <li>Creator Studio (§4.1.2)</li>
              <li>Developer Console &amp; billing (§4.1.4)</li>
            </ul>
          </Card.Content>
        </Card>
      </div>
    </>
  );
}
