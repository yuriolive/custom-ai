"use client";

/**
 * Sub-navigation for /studio. A client component because it reads the current
 * pathname to mark the active tab.
 *
 * Plain links rather than HeroUI `Tabs`, matching `console-nav.tsx`: these are
 * routes, not panels of one page, and a creator mid-deployment needs the back
 * button to work.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/studio", label: "My models" },
  { href: "/studio/new", label: "Deploy a model" },
] as const;

export function StudioNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Studio sections" className="border-border -mx-1 border-b">
      <ul className="flex gap-1 overflow-x-auto overflow-y-hidden px-1">
        {ITEMS.map((item) => {
          const active =
            item.href === "/studio" ? pathname === "/studio" : pathname.startsWith(item.href);

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
