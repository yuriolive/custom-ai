import "server-only";

/**
 * Server-only environment access.
 *
 * Importing this module from a client component is a build error — `server-only`
 * throws at bundle time. That is deliberate: every value below is either a
 * credential or an internal URL, and CONTRACTS.md forbids reading a secret from
 * a NEXT_PUBLIC_* variable.
 *
 * Never log any of these values. Never include them in an error message that
 * reaches the client.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const serverEnv = {
  /** Base URL of the inference gateway. `${gatewayBaseUrl}/v1` is OpenAI-compatible. */
  get gatewayBaseUrl(): string {
    return optional(
      "GATEWAY_BASE_URL",
      "http://127.0.0.1:54321/functions/v1/gateway",
    ).replace(/\/+$/, "");
  },

  /**
   * Platform key presented to the gateway by the playground route handler.
   * MVP-0 placeholder — FR-PLAY-001 replaces this with a session-scoped
   * ephemeral key minted per user.
   */
  get platformApiKey(): string {
    return required("PLATFORM_API_KEY");
  },

  /** Upstream override; points at tools/mock-upstream in tests. */
  get upstreamBaseUrl(): string {
    return optional("UPSTREAM_BASE_URL", "http://127.0.0.1:8787");
  },
} as const;
