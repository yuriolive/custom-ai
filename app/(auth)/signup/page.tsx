import type { Metadata } from "next";

import { SignupForm } from "@/components/auth/signup-form";
import { safeNextPath, SIGNED_IN_HOME } from "@/lib/supabase/middleware";

export const metadata: Metadata = {
  title: "Create an account · Nexus Inference",
  description: "Create an account to publish models and earn on inference.",
};

const INBUCKET_URL = "http://localhost:54324";

/** Local stacks have no SMTP: confirmation mail is captured by Inbucket. */
function isLocalSupabase(): boolean {
  return /(^|\/\/)(127\.0\.0\.1|localhost)(:|$)/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next) ?? SIGNED_IN_HOME;

  return <SignupForm inbucketUrl={INBUCKET_URL} isLocalSupabase={isLocalSupabase()} next={next} />;
}
