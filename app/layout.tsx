import type { Metadata } from "next";

import { SiteNav } from "@/components/site-nav";
import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus Inference",
  description: "Serverless inference marketplace — MVP-0",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning is required (FR-UI-003): next-themes writes
    // `class` and `data-theme` on <html> before React hydrates, so the server
    // and client markup differ on this element by design.
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        {/* No <HeroUIProvider>. HeroUI v3 has no provider. */}
        <ThemeProvider>
          <SiteNav />
          <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
