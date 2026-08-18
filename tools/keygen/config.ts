/**
 * Environment + target-safety resolution.
 *
 * Two hard rules live here, both from the task brief and CONTRACTS.md:
 *
 *   1. `SUPABASE_SERVICE_ROLE_KEY` is read from the ENVIRONMENT ONLY. It is never
 *      accepted as a CLI argument (argv is visible in `ps`, in shell history, and
 *      in CI job logs), never written to disk, never echoed, and never included
 *      in an error message.
 *   2. Minting credentials against a non-local Supabase must be deliberate. A
 *      remote `SUPABASE_URL` is refused unless `--i-know-this-is-production` is
 *      passed explicitly.
 */

import { PLAINTEXT_KEY_RE } from "./key.ts";

export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";
export const URL_ENV = "SUPABASE_URL";
export const PRODUCTION_FLAG = "--i-know-this-is-production";

export interface ResolvedConfig {
  url: string;
  /** Never printed, never persisted, never placed in an error message. */
  serviceRoleKey: string;
  isLocal: boolean;
}

export class ConfigError extends Error {}

const LOCAL_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
  "kong",
]);

/**
 * A URL counts as local only if it resolves to this machine. Anything else —
 * including a *.supabase.co project ref — is treated as production.
 */
export function isLocalSupabaseUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(host)) return true;
  // `foo.localhost` is reserved for loopback (RFC 6761).
  if (host.endsWith(".localhost")) return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * argv must never carry a credential. A bare JWT (`eyJ...`) or an `sk-plat-` key
 * on the command line means it is already in the user's shell history, so we stop
 * rather than quietly proceeding. We never echo the offending value back.
 */
export function assertNoSecretsInArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(value)) {
      throw new ConfigError(
        `A JWT was passed on the command line. ${SERVICE_ROLE_ENV} must come from ` +
          `the environment only — command-line arguments leak into shell history ` +
          `and process listings. Unset it from your history and export it instead:\n` +
          `  export ${SERVICE_ROLE_ENV}=...   # or:  node --env-file=.env cli.ts ...`,
      );
    }
    // Only a FULL key (51 chars) is a credential. The 16-char display prefix is
    // safe to pass — `revoke` takes one — so it must not trip this check.
    if (PLAINTEXT_KEY_RE.test(value)) {
      throw new ConfigError(
        "A full plaintext API key was passed on the command line. Plaintext keys are " +
          "never accepted as input — revoke by key id or by the 16-character " +
          "display prefix instead.",
      );
    }
  }
}

export interface ResolveOptions {
  env: NodeJS.ProcessEnv;
  allowProduction: boolean;
}

export function resolveConfig({ env, allowProduction }: ResolveOptions): ResolvedConfig {
  const url = (env[URL_ENV] ?? "").trim();
  if (!url) {
    throw new ConfigError(
      `${URL_ENV} is not set. Point it at your Supabase instance, e.g.\n` +
        `  export ${URL_ENV}=http://127.0.0.1:54321`,
    );
  }

  const serviceRoleKey = (env[SERVICE_ROLE_ENV] ?? "").trim();
  if (!serviceRoleKey) {
    throw new ConfigError(
      `${SERVICE_ROLE_ENV} is not set. It must come from the environment — it is ` +
        `never accepted as a CLI argument, because arguments are visible in shell ` +
        `history and in process listings. Get the local value with:\n` +
        `  supabase status\n` +
        `then:\n` +
        `  export ${SERVICE_ROLE_ENV}=<value>   # or:  node --env-file=.env cli.ts ...`,
    );
  }

  const isLocal = isLocalSupabaseUrl(url);
  if (!isLocal && !allowProduction) {
    throw new ConfigError(
      `Refusing to run against a non-local Supabase: ${url}\n` +
        `Minting or revoking real credentials must be deliberate. If you truly mean ` +
        `to target this instance, re-run with ${PRODUCTION_FLAG}.`,
    );
  }

  return { url: url.replace(/\/+$/, ""), serviceRoleKey, isLocal };
}
