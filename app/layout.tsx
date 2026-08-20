import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

/**
 * Self-hosted at build time by `next/font`: no third-party request at runtime,
 * and a `size-adjust` fallback so swapping the face in costs no layout shift.
 *
 * Inter for prose and UI — its `tnum` figures are genuinely monospaced, which
 * is what makes `tabular-nums` hold a money column still. JetBrains Mono for
 * code and identifiers, where a slashed zero and unambiguous `1lI` are the
 * whole job when the thing on screen is an API key someone is about to retype.
 */
const sans = Inter({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-sans-face",
});

const mono = JetBrains_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-mono-face",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Nexus Inference",
  description: "Serverless inference marketplace — MVP-0",
};

/**
 * `<html>`, `<body>`, the two faces, and the theme. NOTHING ELSE.
 *
 * This layout used to render `SiteNav` and a `max-w-6xl` `<main>` for every
 * route, which meant a marketing page and a console page were the same shape by
 * construction — a landing hero could not go full-bleed and a signed-out visitor
 * on `/login` got a nav carrying a wallet balance. The shell now belongs to the
 * four route groups (docs/UI-REDESIGN-PLAN.md §3):
 *
 *   (marketing)  pill nav, full-bleed sections, footer   → `/`
 *   (catalog)    pill nav, centred column, footer        → `/models/**`
 *   (app)        product nav, centred column             → console/studio/playground
 *   (auth)       pill nav, one centred card              → login/signup
 *
 * Each owns its own `<main>`. Adding one back here would give every page two.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning is required (FR-UI-003): next-themes writes
    // `class` and `data-theme` on <html> before React hydrates, so the server
    // and client markup differ on this element by design.
    <html className={`${sans.variable} ${mono.variable}`} lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground font-sans min-h-dvh antialiased">
        {/* No <HeroUIProvider>. HeroUI v3 has no provider. */}
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
