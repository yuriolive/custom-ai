import Link from "next/link";

import { BalanceChip } from "@/components/balance-chip";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Minimal root nav. MVP-0 ships exactly two destinations; the marketplace,
 * Creator Studio and Console are deliberately out of scope.
 */
export function SiteNav() {
  return (
    <header className="border-b border-default sticky top-0 z-40 bg-background/85 backdrop-blur">
      <nav className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
        <Link
          className="font-semibold tracking-tight text-foreground"
          href="/"
        >
          nexus
          <span className="text-muted font-normal"> / inference</span>
        </Link>

        <Link
          className="text-muted hover:text-foreground text-sm transition-colors"
          href="/playground"
        >
          Playground
        </Link>

        <div className="ml-auto flex items-center gap-3">
          <BalanceChip />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
