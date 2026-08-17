"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Theme switching for HeroUI v3.
 *
 * NOTE: this is next-themes, NOT a HeroUI provider. HeroUI v3 has no provider —
 * `<HeroUIProvider>` does not exist and importing it is a lint error here.
 *
 * HeroUI's stylesheet keys off both `class="dark"` and `[data-theme="dark"]`
 * (PRD FR-UI-003), so next-themes is configured to write both attributes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute={["class", "data-theme"]}
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
