/**
 * Shell for /login and /signup.
 *
 * Plain markup only — no HeroUI import — so this stays a Server Component
 * (§4.1.0: `@heroui/react` is client-only). Responsive down to 375px: the card
 * is full width with page padding on mobile and caps at 26rem from `sm` up.
 */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-[calc(100dvh-8rem)] w-full items-start justify-center py-6 sm:items-center sm:py-12">
      <div className="w-full max-w-[26rem]">{children}</div>
    </div>
  );
}
