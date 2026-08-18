import type { Metadata } from "next";

import { LoginForm } from "@/components/auth/login-form";
import { messageForQueryCode } from "@/lib/supabase/auth-errors";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";

export const metadata: Metadata = {
  title: "Sign in · Nexus Inference",
  description: "Sign in to deploy models and mint API keys.",
};

/**
 * Server Component: resolves the query string, then hands plain props to the
 * client form (§4.1.0). An already-signed-in visitor never reaches this render
 * — the middleware sends them to /console first.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; authError?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next) ?? SIGNED_IN_HOME;

  // Only the CODE crosses the URL; the copy is resolved here, so the page
  // never renders attacker-supplied text from a query string.
  const initialError = messageForQueryCode(params.authError);

  return <LoginForm initialError={initialError} next={next} />;
}
