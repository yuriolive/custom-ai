/**
 * The marketing nav's destinations, in one place so the pill and the mobile
 * Drawer cannot disagree about them.
 *
 * EVERY HREF HERE MUST BE A ROUTE THAT EXISTS. A marketing nav that links to a
 * page nobody has built is the cheapest possible way to make a product look
 * abandoned, and it is the failure mode this file exists to make visible: the
 * list is short because the app is young, and it grows when a route does.
 *
 * `/models` is the public catalog. It is a stub until the landing page takes
 * over `/` (docs/UI-REDESIGN-PLAN.md §3), which is the same change that makes
 * this nav reachable — so the two land together or neither does.
 */
export type MarketingLink = Readonly<{ href: string; label: string }>;

export const MARKETING_LINKS: readonly MarketingLink[] = [
  { href: "/models", label: "Models" },
  { href: "/playground", label: "Playground" },
] as const;
