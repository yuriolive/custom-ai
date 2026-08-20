/**
 * Conversation history, stored in the browser and nowhere else (FR-CHAT-007).
 *
 * There is no `chat_threads` table and there is deliberately not going to be one
 * in v1. Two reasons, in order of weight:
 *
 *  1. It is the honest default for this product. The platform already sees every
 *     prompt in transit — it is the inference provider — but keeping a durable,
 *     queryable copy of what people typed is a different commitment, and one
 *     worth not making by accident on the way to shipping a UI.
 *  2. It costs no migration, no RLS policy, and no delete endpoint to get wrong.
 *
 * The consequence is stated to the user, not buried: history lives in this
 * browser, does not follow them to their phone, and clearing site data clears it.
 *
 * This module takes a storage object rather than reaching for `window`, so all
 * of the below is exercised by `history.test.ts` with a plain in-memory double.
 */

import type { TurnMetrics } from "@/lib/types";

/** Bumped only when the shape below changes incompatibly; old keys are dropped. */
export const HISTORY_STORAGE_KEY = "nx.chat.threads.v1";

/**
 * Threads kept before the oldest is dropped.
 *
 * `localStorage` is a hard ~5MB per origin and throws `QuotaExceededError` on
 * overflow — a write that fails is a conversation the user watched disappear, so
 * the budget is spent deliberately here rather than discovered at the limit.
 */
export const MAX_THREADS = 20;
/** Messages kept per thread. A long thread is truncated from the front. */
export const MAX_MESSAGES_PER_THREAD = 200;
/** Hard ceiling on the serialized blob, well under the 5MB origin quota. */
export const MAX_SERIALIZED_BYTES = 1_500_000;

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Per-turn metering, assistant messages only. */
  metrics?: TurnMetrics | null;
};

export type ChatThread = {
  id: string;
  /** Platform model id this thread is talking to, `creator/slug`. */
  modelId: string;
  title: string;
  /** Epoch millis. Sorting key for the thread list. */
  updatedAt: number;
  messages: StoredMessage[];
};

/** The subset of `Storage` used here, so tests need no DOM. */
export type MinimalStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * A thread title, derived from the first thing the user said.
 *
 * Derived rather than model-generated: asking the model to name the thread would
 * bill a second request for every conversation, and on a scale-to-zero worker it
 * would also be the slowest possible way to label a list.
 */
export function titleFromText(text: string, max = 48): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return "New chat";
  if (flat.length <= max) return flat;
  // Cut on a word boundary when one is near the limit, so titles do not end
  // mid-word for the sake of three characters.
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function createThread(id: string, modelId: string, now: number): ChatThread {
  return { id, modelId, title: "New chat", updatedAt: now, messages: [] };
}

/** Newest first. Ties broken by id so the order never flickers between renders. */
export function sortThreads(threads: ChatThread[]): ChatThread[] {
  return threads.toSorted((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : 1;
  });
}

export function upsertThread(threads: ChatThread[], thread: ChatThread): ChatThread[] {
  const without = threads.filter((t) => t.id !== thread.id);
  return sortThreads([thread, ...without]);
}

/**
 * Trim to the budget: newest `MAX_THREADS`, and the tail of each thread's
 * messages.
 *
 * Truncating from the FRONT of a thread rather than the back is the only
 * defensible direction — the recent turns are the ones the conversation depends
 * on, and they are also what the model would be sent on the next turn.
 */
export function pruneThreads(threads: ChatThread[]): ChatThread[] {
  return sortThreads(threads)
    .slice(0, MAX_THREADS)
    .map((thread) =>
      thread.messages.length <= MAX_MESSAGES_PER_THREAD
        ? thread
        : { ...thread, messages: thread.messages.slice(-MAX_MESSAGES_PER_THREAD) },
    );
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.text === "string"
  );
}

function isChatThread(value: unknown): value is ChatThread {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.modelId === "string" &&
    typeof t.title === "string" &&
    typeof t.updatedAt === "number" &&
    Array.isArray(t.messages) &&
    t.messages.every(isStoredMessage)
  );
}

/**
 * Read the stored threads.
 *
 * Anything unparseable or shape-wrong returns `[]` instead of throwing. This
 * value comes from a place the user can edit with devtools and that an older
 * build of this app may have written — a chat that white-screens on a stale key
 * is a worse outcome than a chat that starts empty.
 */
export function loadThreads(storage: MinimalStorage): ChatThread[] {
  let raw: string | null;
  try {
    raw = storage.getItem(HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortThreads(parsed.filter(isChatThread));
  } catch {
    return [];
  }
}

/**
 * Persist, shedding oldest threads until it fits.
 *
 * Returns what was actually written, so the caller's state matches storage
 * rather than describing a conversation that was silently dropped.
 */
export function saveThreads(storage: MinimalStorage, threads: ChatThread[]): ChatThread[] {
  let candidate = pruneThreads(threads);

  while (candidate.length > 0) {
    const serialized = JSON.stringify(candidate);
    if (serialized.length <= MAX_SERIALIZED_BYTES) {
      try {
        storage.setItem(HISTORY_STORAGE_KEY, serialized);
        return candidate;
      } catch {
        // QuotaExceededError, or storage disabled entirely (Safari private
        // mode). Drop the oldest thread and try once more; if storage is off
        // altogether the loop exits below and chat still works for this tab.
      }
    }
    candidate = candidate.slice(0, -1);
  }

  try {
    storage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Nothing left to do — the session simply is not persisted.
  }
  return [];
}

export function clearThreads(storage: MinimalStorage): void {
  try {
    storage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Storage unavailable; there is nothing stored to clear either.
  }
}
