/**
 * POST /api/studio/refs — the Revision field's option list.
 *
 * Called on blur of the repo field, BEFORE the weight probe, so the ComboBox
 * can preselect the repository's actual default branch and the probe then runs
 * against a ref that exists. The bug this closes is quiet rather than loud: the
 * Revision field free-texted to the literal string `"main"`, so any repository
 * whose default branch is not `main` was probed at a ref that is not there.
 *
 * SERVER-SIDE for the same reason the probe is (see the header of
 * `lib/studio/server/probe.ts`): huggingface.co sends no CORS headers, so the
 * browser cannot read this endpoint at all.
 *
 * THE TOKEN is treated exactly as the probe route treats it — read from the
 * body, passed straight to the Hub as a bearer, dropped when the request ends.
 * Not stored, not logged, not echoed in any response.
 *
 * EVERY OUTCOME IS 200 AND NOTHING THROWS. Refs are an affordance: the field
 * keeps `allowsCustomValue` because a commit SHA cannot be enumerated, so a
 * repository that will not list its branches costs the creator a dropdown and
 * nothing else.
 */

import { fetchRepoRefs } from "@/lib/studio/server/probe";
import { createClient } from "@/lib/supabase/server";

/** Node, matching the probe route: same outbound host, same redirect handling. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function refsFailure(code: string, message: string): Response {
  return Response.json({ ok: false, code, message }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  // Studio is behind the middleware's authenticated route table, but a route
  // handler is not a page and the matcher does not cover it. Without this check
  // the route is an open, unauthenticated proxy to arbitrary Hugging Face URLs.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return refsFailure("unauthenticated", "Sign in to list a repository's branches.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refsFailure("invalid_request_body", "Expected a JSON body.");
  }

  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const slug = typeof fields.repoSlug === "string" ? fields.repoSlug : "";
  const token = typeof fields.hfToken === "string" ? fields.hfToken.trim() : "";

  const result = await fetchRepoRefs(slug, {
    ...(token ? { hfToken: token } : {}),
    signal: request.signal,
  });

  return Response.json(result, {
    // The branch list of a private repo, read with the creator's token. It must
    // not sit in a shared cache.
    headers: { "Cache-Control": "no-store" },
  });
}
