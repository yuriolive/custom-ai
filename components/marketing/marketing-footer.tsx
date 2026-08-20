import type { Route } from "next";
import Link from "next/link";

import { Wordmark } from "@/components/wordmark";

import { MarketingContainer } from "./section";

/**
 * The marketing footer.
 *
 * DELIBERATELY SHORT. Modal's footer runs to four columns because they have
 * four columns' worth of pages; ours has the routes that exist and nothing
 * else. A footer padded out with dead links — a Careers page nobody wrote, a
 * Status page nobody hosts — is the clearest possible signal that the rest of
 * the site is also a facade. It grows when a route does.
 *
 * Server Component, plain markup, no `@heroui/react` (PRD §4.1.0).
 */

type FooterLink = Readonly<{ href: Route; label: string }>;

const PRODUCT: readonly FooterLink[] = [
  { href: "/models", label: "Model catalog" },
  { href: "/pricing", label: "Pricing" },
  { href: "/playground", label: "Playground" },
  { href: "/studio/new", label: "Deploy a model" },
] as const;

const LEGAL: readonly FooterLink[] = [
  { href: "/legal/terms", label: "Terms of service" },
  { href: "/legal/acceptable-use", label: "Acceptable use" },
] as const;

const ACCOUNT: readonly FooterLink[] = [
  { href: "/console", label: "Console" },
  { href: "/console/keys", label: "API keys" },
  { href: "/console/usage", label: "Usage" },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-border mt-8 border-t">
      <MarketingContainer className="flex flex-col gap-10 py-12">
        <div className="grid gap-10 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-3">
            <Wordmark />
            <p className="text-muted max-w-xs text-sm leading-[1.55]">
              Serverless inference for open models. One OpenAI-compatible endpoint, per-token
              pricing, and most of the bill going to whoever published the model.
            </p>
          </div>

          <FooterColumn heading="Product" links={PRODUCT} />
          <FooterColumn heading="Account" links={ACCOUNT} />
          <FooterColumn heading="Legal" links={LEGAL} />
        </div>

        <div className="border-border text-muted flex flex-col gap-2 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getUTCFullYear()} Nexus Inference</p>
          {/* Stated in the footer as well as the landing page, because the cold
              start is the one property of this product that surprises people,
              and a visitor who scrolled past section 4 should still meet it. */}
          <p>Models sleep when idle — a first call can take up to two minutes.</p>
        </div>
      </MarketingContainer>
    </footer>
  );
}

function FooterColumn({
  heading,
  links,
}: Readonly<{ heading: string; links: readonly FooterLink[] }>) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {heading}
      </h2>
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              className="text-muted hover:text-foreground focus-visible:ring-accent rounded-sm text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
              href={link.href}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
