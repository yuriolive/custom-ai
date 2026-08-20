/**
 * Gateway errors, rewritten for someone who is not holding the API docs
 * (FR-CHAT-008).
 *
 * The gateway answers in the OpenAI envelope with a machine `code`
 * (CONTRACTS.md §Gateway wire contract). That envelope is exactly right for an
 * SDK and exactly wrong for a chat window: "insufficient_balance" is not a
 * sentence, and a consumer who hits it needs the top-up link, not the code.
 *
 * The mapping is deliberately total. An unrecognised code still produces a
 * sentence that says what happened and what to do, because the alternative —
 * rendering the raw envelope — is how a product teaches people that it is
 * broken.
 */

export type ChatErrorAction = {
  label: string;
  href: string;
};

export type ChatErrorPresentation = {
  /** Machine code, kept for the data attribute a test can assert on. */
  code: string;
  title: string;
  description: string;
  action: ChatErrorAction | null;
  /** Whether re-sending the same message could plausibly work. */
  retryable: boolean;
};

/**
 * Marker prefix used to smuggle the gateway's `code` through the AI SDK's
 * error channel, which carries a string and nothing else.
 *
 * The route handler emits `«nx:code»human sentence`; the client splits it back
 * apart. Without this the client would have to re-parse an English message to
 * decide whether to show a top-up button, which breaks the first time the copy
 * is edited.
 */
const CODE_MARKER_RE = /^«nx:([a-z_]+)»/u;

export function encodeChatError(code: string, message: string): string {
  return `«nx:${code}»${message}`;
}

export function decodeChatError(raw: string | undefined | null): {
  code: string | null;
  message: string;
} {
  if (!raw) return { code: null, message: "" };
  const match = CODE_MARKER_RE.exec(raw);
  if (!match) return { code: null, message: raw };
  return { code: match[1] ?? null, message: raw.slice(match[0].length) };
}

/**
 * Pull the `code` out of an OpenAI error envelope.
 *
 * Tolerates a body that is not JSON at all: an upstream proxy returning an HTML
 * error page is a real thing that happens, and it must not throw here.
 */
export function parseGatewayErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

const WALLET_ACTION: ChatErrorAction = { label: "Add funds", href: "/console/wallet" };
const CATALOG_ACTION: ChatErrorAction = { label: "Browse models", href: "/" };

/**
 * Note on 402: the balance check happens at authorization, against a HOLD sized
 * for the whole turn, not against the cost of the tokens produced so far. So
 * "you ran out mid-sentence" is not what happened and the copy must not say it.
 */
export function presentChatError(
  code: string | null,
  fallbackMessage?: string,
): ChatErrorPresentation {
  switch (code) {
    case "insufficient_balance":
      return {
        code,
        title: "Not enough balance for this message",
        description:
          "Your wallet has to cover the whole reply up front, and it is short. Top up and send " +
          "the message again — nothing was charged.",
        action: WALLET_ACTION,
        retryable: false,
      };

    case "model_unavailable":
      return {
        code,
        title: "This model is not serving right now",
        description:
          "The creator has it deployed but not ready. Pick another model — your conversation " +
          "stays where it is.",
        action: CATALOG_ACTION,
        retryable: false,
      };

    case "model_not_found":
      return {
        code,
        title: "That model is not on the catalog",
        description:
          "It may have been unpublished or made private since this link was shared. Pick another " +
          "one to carry on.",
        action: CATALOG_ACTION,
        retryable: false,
      };

    case "cold_start_timeout":
      return {
        code,
        title: "The worker took too long to wake",
        description:
          "This model scales to zero, and starting it exceeded the time budget. Sending again " +
          "usually lands on a worker that is already coming up. You were not charged.",
        action: null,
        retryable: true,
      };

    case "stream_timeout":
      return {
        code,
        title: "The reply stopped early",
        description:
          "The connection to the worker went quiet mid-reply. Send again — you are billed only " +
          "for what was actually generated.",
        action: null,
        retryable: true,
      };

    case "invalid_api_key":
    case "revoked_api_key":
      return {
        code,
        title: "This chat session expired",
        description:
          "Its credential was revoked or timed out. Reload the page to start a fresh session; " +
          "your conversation is stored in this browser and will still be here.",
        action: null,
        retryable: false,
      };

    case "unauthenticated":
      return {
        code,
        title: "You are signed out",
        description: "Sign in again to keep chatting. Nothing in this conversation was lost.",
        action: { label: "Sign in", href: "/login" },
        retryable: false,
      };

    case "invalid_model_format":
      return {
        code,
        title: "That model id is malformed",
        description:
          "A model id looks like creator-handle/model-slug. Pick a model from the list instead " +
          "of editing the address bar.",
        action: CATALOG_ACTION,
        retryable: false,
      };

    default:
      return {
        code: code ?? "unknown",
        title: "The reply did not come through",
        // Not "still in the composer": chat clears the box on send and puts the
        // message in the transcript, so that sentence would be a lie the user
        // can see on screen.
        description:
          (fallbackMessage?.trim() || "The gateway did not return a response.") +
          " Your message is still in the conversation — send it again to retry.",
        action: null,
        retryable: true,
      };
  }
}
