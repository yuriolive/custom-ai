"use client";

import { Button, Drawer } from "@heroui/react";
import Link from "next/link";

import type { MarketingLink } from "./links";

/**
 * The sub-`md:` half of the marketing nav.
 *
 * A 48px pill cannot hold a centred link row and an auth cluster at 375px, so
 * below `md:` the pill keeps only the wordmark and this trigger, and everything
 * else moves into a Drawer. Client-only, because `@heroui/react` is
 * (PRD §4.1.0) — which is why the nav itself stays a Server Component and hands
 * this component plain serializable props.
 */
export function MarketingMenu({
  links,
  isSignedIn,
}: Readonly<{ links: readonly MarketingLink[]; isSignedIn: boolean }>) {
  return (
    <Drawer>
      <Drawer.Trigger>
        <Button aria-label="Open menu" size="sm" variant="ghost">
          {/* A hamburger is the one glyph that carries meaning no word fits in
              the space available, so it is allowed under DESIGN.md §4 item 4.
              Three <span>s rather than an icon dependency. */}
          <span aria-hidden className="flex flex-col gap-[3px]">
            <span className="bg-foreground block h-px w-4" />
            <span className="bg-foreground block h-px w-4" />
            <span className="bg-foreground block h-px w-4" />
          </span>
        </Button>
      </Drawer.Trigger>

      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog>
            <Drawer.Header>
              <Drawer.Heading>Menu</Drawer.Heading>
              <Drawer.CloseTrigger />
            </Drawer.Header>

            <Drawer.Body>
              <nav aria-label="Site">
                <ul className="flex flex-col gap-1">
                  {links.map((link) => (
                    <li key={link.href}>
                      <Link
                        className="text-foreground hover:bg-surface-secondary focus-visible:ring-accent block rounded-md px-3 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                        href={link.href}
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </Drawer.Body>

            <Drawer.Footer>
              {/* An anchor, not a Button: HeroUI v3's Button is a React Aria
                  <button> and takes no href (DESIGN.md §6 item 15). Styled to
                  match a primary Button. */}
              <Link
                className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-9 w-full items-center justify-center rounded-field px-4 text-sm font-medium hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
                href={isSignedIn ? "/console" : "/signup"}
              >
                {isSignedIn ? "Open the console" : "Get started"}
              </Link>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
