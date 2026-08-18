"use client";

/**
 * Sub-navigation for /console. A client component because it reads the current
 * pathname to mark the active tab.
 *
 * Deliberately plain links rather than HeroUI `Tabs`: these are four routes, not
 * four panels of one page. Tabs would either need a router bridge or would swap
 * content without changing the URL, and a developer console needs shareable,
 * back-button-safe URLs.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/console", label: "Overview" },
  { href: "/console/keys", label: "API keys" },
  { href: "/console/usage", label: "Usage" },
  { href: "/console/wallet", label: "Wallet" },
] as const;

export function ConsoleNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Console sections" className="border-default -mx-1 border-b">
      {/* Scrolls rather than wraps at 375px, so the row stays one line. */}
      <ul className="flex gap-1 overflow-x-auto px-1">
        {ITEMS.map((item) => {
          // Exact match for the index route; prefix match for the sub-pages, so
          // a future /console/usage/[id] still lights up "Usage".
          const active =
            item.href === "/console"
              ? pathname === "/console"
              : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                aria-current={active ? "page" : undefined}
                className={[
                  "-mb-px inline-block border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
                  "focus-visible:ring-accent rounded-t focus-visible:ring-2 focus-visible:outline-none",
                  active
                    ? "border-accent text-foreground font-medium"
                    : "text-muted hover:text-foreground border-transparent",
                ].join(" ")}
                href={item.href}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
