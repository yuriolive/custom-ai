/**
 * POST /api/studio/probe — FR-STU-002, FR-DEP-001…006.
 *
 * Called on blur of the repo field, and again when a token is supplied. Returns
 * the discovered variants, the model's attention geometry, and whether the repo
 * needs a credential — everything the consequence table and the Deployment Plan
 * need, and nothing that identifies the caller.
 *
 * THE TOKEN. A Hugging Face read token grants access to a creator's entire
 * private namespace, so this route treats it as a credential in transit and
 * nothing more: it is read from the body, passed to the probe, and dropped when
 * the request ends. It is not stored, not logged, not echoed in any response
 * (success or failure), and every outbound message is passed through the
 * FR-DEP-013 redaction filter on the way out. Storage happens once, later, in
 * the deploy route — into Vault, never into a column.
 */

import { probeForStudio } from "@/lib/studio/server/probe";
import { createClient } from "@/lib/supabase/server";

/** Node, not edge: the GGUF header read needs Range requests and redirects. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A GGUF header read is a redirect chain plus a ranged CDN fetch, and the probe
 * walks up to 1 MB of it. 30 s is generous for a healthy repo and well short of
 * a hung socket holding a route worker open.
 */
export const maxDuration = 60;

function errorResponse(status: number, code: string, message: string) {
  return Response.json(
    { ok: false, code, message, requiresAuth: false, isPrivate: false, isGated: false },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  // Studio is behind the middleware's authenticated route table, but this is a
  // route handler and not a page — the matcher does not protect it the way it
  // protects /studio, so the session check has to be here as well. Without it
  // this is an open, unauthenticated proxy to arbitrary Hugging Face URLs.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return errorResponse(401, "unauthenticated", "Sign in to probe a repository.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request_body", "Expected a JSON body.");
  }

  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const slug = typeof fields.repoSlug === "string" ? fields.repoSlug : "";
  const revision = typeof fields.revision === "string" ? fields.revision : "main";
  const token = typeof fields.hfToken === "string" ? fields.hfToken.trim() : "";

  const result = await probeForStudio(supabase, slug, {
    revision,
    ...(token ? { hfToken: token } : {}),
    signal: request.signal,
  });

  // Always 200: every outcome here is a form state the UI renders inline as an
  // Alert (FR-STU-002 — "an inline Alert, not a Toast"), not an exception. A
  // gated repo is a thing the creator can fix, not a failed request.
  return Response.json(result, {
    // The response describes a private repo's file list when a token was used.
    // It must not sit in a shared cache.
    headers: { "Cache-Control": "no-store" },
  });
}
