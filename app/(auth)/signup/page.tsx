import type { Metadata } from "next";

import { SignupForm } from "@/components/auth/signup-form";
import { INBUCKET_URL, isLocalSupabase } from "@/lib/supabase/is-local";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Create an account to publish models and earn on inference.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next) ?? SIGNED_IN_HOME;

  return <SignupForm inbucketUrl={INBUCKET_URL} isLocalSupabase={isLocalSupabase()} next={next} />;
}
