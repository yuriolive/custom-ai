import { SiteNav } from "@/components/site-nav";

/**
 * The product shell — console, studio, playground.
 *
 * This is deliberately the SMALL version of the change: it lifts the nav and the
 * centred column that `app/layout.tsx` used to apply to every route, so these
 * pages render exactly as they did before the marketing split, and nothing else.
 *
 * The sidebar shell (240/48px rail, `mod+b`, breadcrumbs) is
 * docs/UI-REDESIGN-PLAN.md §5 and is a separate change with its own verification
 * pass — it can break every authenticated route at once, and it has no business
 * riding along with a landing-page refresh. `SiteNav` stays here until it lands.
 *
 * The per-route `getCurrentUser()` guards in `console/layout.tsx` and
 * `studio/layout.tsx` are NOT hoisted here. Both files state why they exist —
 * the middleware matcher is a regex someone will edit one day — and collapsing
 * two second-lines-of-defence into one is only worth doing as part of §5, where
 * the route tables move anyway.
 */
export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
