"use client";

import { useChat } from "@ai-sdk/react";
import { Alert, AlertDialog, Button, Dropdown } from "@heroui/react";
import { DefaultChatTransport } from "ai";
import type { Route } from "next";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { EllipsisIcon, PlusIcon, TrashIcon } from "@/components/chat/icons";
import { ModelFooterNote, ModelPicker } from "@/components/chat/model-picker";
import { Transcript, messageText } from "@/components/chat/transcript";
import { ColdStartNotice } from "@/components/cold-start-notice";
import type { CatalogModel } from "@/components/marketplace/types";
import { decodeChatError, parseGatewayErrorCode, presentChatError } from "@/lib/chat/errors";
import {
  clearThreads,
  createThread,
  loadThreads,
  removeThread,
  saveThreads,
  titleFromText,
  upsertThread,
  type ChatThread,
  type StoredMessage,
} from "@/lib/chat/history";
import { publicEnv } from "@/lib/public-env";
import type { ChatUIMessage } from "@/lib/types";

/**
 * Openers for a blank chat.
 *
 * They FILL the composer; they never send. The first request of a session wakes
 * a scale-to-zero worker and takes about a minute and a half, and spending that
 * on a misclick is hostile — the same rule the playground's seed prompts follow.
 *
 * Two lines each, because a bare prompt string wraps into an unreadable slab at
 * this width. The title is what it does; the second line is the prompt it fills.
 */
const SUGGESTIONS = [
  {
    title: "Explain it simply",
    prompt: "Explain what a VPN actually does, in plain language, to someone non-technical.",
  },
  {
    title: "Write a reply",
    prompt: "Help me write a polite message declining a meeting invitation I have no time for.",
  },
  {
    title: "Plan the week",
    prompt: "Give me a week of simple dinners for two, with one combined shopping list.",
  },
  {
    title: "Both sides",
    prompt: "Summarise the argument for and against nuclear power in ten lines, evenly.",
  },
] as const;

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function toUIMessages(messages: StoredMessage[]): ChatUIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: [{ type: "text" as const, text: message.text }],
    metadata: message.metrics ?? undefined,
  }));
}

function toStoredMessages(messages: ChatUIMessage[]): StoredMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      text: messageText(message),
      metrics: message.metadata ?? null,
    }));
}

export function ChatApp({
  models,
  initialModelId,
  unavailableModelId,
}: Readonly<{
  models: CatalogModel[];
  initialModelId: string | null;
  /** A `?model=` that is not on the public catalog. Shown, never 404'd. */
  unavailableModelId: string | null;
}>) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string>(() => newId());
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [input, setInput] = useState("");
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [dismissedUnavailable, setDismissedUnavailable] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  /**
   * Which model produced which assistant message.
   *
   * A thread may switch models mid-conversation, and the per-turn cost estimate
   * has to use the prices of the model that actually ran — not whatever is
   * selected in the picker by the time the user scrolls back up.
   */
  const [messageModel, setMessageModel] = useState<Record<string, string>>({});

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const modelsById = useMemo(
    () => new Map(models.map((model) => [model.modelId, model])),
    [models],
  );
  const selectedModel = modelId ? (modelsById.get(modelId) ?? null) : null;

  const [transport] = useState(() => new DefaultChatTransport<ChatUIMessage>({ api: "/api/chat" }));
  const { messages, sendMessage, regenerate, status, stop, error, clearError, setMessages } =
    useChat<ChatUIMessage>({ transport });

  const isSubmitted = status === "submitted"; // sent, no first token yet
  const isStreaming = status === "streaming";
  const isBusy = isSubmitted || isStreaming;
  const isBlank = messages.length === 0;

  // ── History. Read once, on the client only: localStorage does not exist
  // during the server render, and a mismatch here would be a hydration error.
  useEffect(() => {
    setThreads(loadThreads(window.localStorage));
    setHistoryLoaded(true);
  }, []);

  // Persist when a turn settles, never mid-stream: writing on every token would
  // serialize the whole conversation dozens of times a second.
  useEffect(() => {
    if (!historyLoaded || isBusy || messages.length === 0 || !modelId) return;

    const stored = toStoredMessages(messages);
    const firstUserText = stored.find((message) => message.role === "user")?.text ?? "";

    setThreads((current) => {
      const existing = current.find((thread) => thread.id === threadId);
      const thread: ChatThread = {
        ...(existing ?? createThread(threadId, modelId, Date.now())),
        modelId,
        // The title is set once, from the opening message, and then left alone —
        // a list whose entries rename themselves as a conversation goes on is
        // impossible to navigate.
        title:
          existing && existing.title !== "New chat" ? existing.title : titleFromText(firstUserText),
        updatedAt: Date.now(),
        messages: stored,
      };
      return saveThreads(window.localStorage, upsertThread(current, thread));
    });
  }, [historyLoaded, isBusy, messages, modelId, threadId]);

  // Follow the stream. `smooth` on a token-by-token stream fights the browser's
  // own scroll anchoring, so this is deliberately instant.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isSubmitted]);

  const seedComposer = useCallback((prompt: string) => {
    setInput(prompt);
    const el = composerRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(prompt.length, prompt.length);
  }, []);

  const startNewChat = useCallback(() => {
    stop();
    clearError();
    setMessages([]);
    setThreadId(newId());
    setInput("");
  }, [clearError, setMessages, stop]);

  const openThread = useCallback(
    (thread: ChatThread) => {
      stop();
      clearError();
      setThreadId(thread.id);
      setModelId(thread.modelId);
      setMessages(toUIMessages(thread.messages));
      setMessageModel((current) => {
        const next = { ...current };
        for (const message of thread.messages) {
          if (message.role === "assistant") next[message.id] ??= thread.modelId;
        }
        return next;
      });
    },
    [clearError, setMessages, stop],
  );

  /**
   * Deleting the thread you are reading also clears the transcript.
   *
   * Leaving the messages on screen after their conversation is gone would show
   * something the user just erased, and the next settled turn would silently
   * write it back under a new id.
   */
  const deleteThread = useCallback(
    (id: string) => {
      setThreads((current) => saveThreads(window.localStorage, removeThread(current, id)));
      if (id === threadId) startNewChat();
    },
    [startNewChat, threadId],
  );

  const deleteAll = useCallback(() => {
    clearThreads(window.localStorage);
    setThreads([]);
    setConfirmDeleteAll(false);
    startNewChat();
  }, [startNewChat]);

  const requestDeleteAll = useCallback(() => setConfirmDeleteAll(true), []);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || !modelId) return;
    clearError();
    setTurnStartedAt(Date.now());
    setInput("");
    void sendMessage({ text }, { body: { model: modelId } });
  }, [clearError, input, isBusy, modelId, sendMessage]);

  // The assistant message id is only known once it exists, so the model is
  // recorded against every assistant message that has not been attributed yet.
  useEffect(() => {
    if (!modelId) return;
    setMessageModel((current) => {
      let changed = false;
      const next = { ...current };
      for (const message of messages) {
        if (message.role === "assistant" && next[message.id] === undefined) {
          next[message.id] = modelId;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [messages, modelId]);

  const modelForMessage = useCallback(
    (messageId: string) => {
      const id = messageModel[messageId] ?? modelId;
      return id ? (modelsById.get(id) ?? null) : null;
    },
    [messageModel, modelId, modelsById],
  );

  const decoded = decodeChatError(error?.message);
  const presented = error
    ? presentChatError(decoded.code ?? parseGatewayErrorCode(decoded.message), decoded.message)
    : null;

  if (models.length === 0) {
    return (
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>No models are published yet</Alert.Title>
          <Alert.Description>
            The catalog is empty, so there is nothing to talk to. If you have a model on Hugging
            Face, Studio will deploy and list it.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const notices = (
    <>
      {unavailableModelId && !dismissedUnavailable ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>That link points at a model we cannot open</Alert.Title>
            <Alert.Description>
              <span className="font-mono">{unavailableModelId}</span> is not on the public catalog —
              it may have been unpublished. Another model is selected instead.
            </Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="ghost" onPress={() => setDismissedUnavailable(true)}>
            Dismiss
          </Button>
        </Alert>
      ) : null}

      {isSubmitted && turnStartedAt !== null ? <ColdStartNotice startedAt={turnStartedAt} /> : null}

      {presented ? (
        <Alert status={presented.code === "insufficient_balance" ? "warning" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{presented.title}</Alert.Title>
            <Alert.Description>{presented.description}</Alert.Description>
          </Alert.Content>
          <div className="flex items-center gap-2">
            {presented.action ? (
              <Link
                className="text-accent text-sm font-medium hover:underline"
                href={presented.action.href as Route}
              >
                {presented.action.label}
              </Link>
            ) : null}
            {/* Only where sending the same thing again could actually work — a
                timeout, not a 402. Offering "try again" on an error that will
                repeat is how a product wastes someone's money. */}
            {presented.retryable ? (
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  clearError();
                  if (modelId) void regenerate({ body: { model: modelId } });
                }}
              >
                Try again
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onPress={() => clearError()}>
              Dismiss
            </Button>
          </div>
        </Alert>
      ) : null}
    </>
  );

  const composer = (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
      {isBlank ? <Suggestions onSeed={seedComposer} /> : null}
      <Composer
        inputRef={composerRef}
        isBusy={isBusy}
        onChange={setInput}
        onStop={() => stop()}
        onSubmit={submit}
        value={input}
      />
      <ModelFooterNote
        coldStartSeconds={publicEnv.coldStartEstimateSeconds}
        model={selectedModel}
      />
    </div>
  );

  return (
    // The height is the app shell's, spelled out: `(app)/layout.tsx` is a
    // min-h-dvh column whose <main> carries h-14 of nav above it and py-8 of
    // padding around it — 3.5rem + 4rem. Subtracting it is what lets the
    // transcript own the scrolling instead of the page.
    <div className="flex h-[calc(100dvh-7.5rem-1px)] min-h-[32rem] gap-8">
      {/* Deleting one conversation is a click, because it is one conversation
          and the row it sits on says which. Deleting every conversation in the
          browser is not recoverable and gets asked about. Mounted only while
          open, like every dialog in this app that actually closes. */}
      {confirmDeleteAll ? (
        <AlertDialog isOpen onOpenChange={(open) => !open && setConfirmDeleteAll(false)}>
          <AlertDialog.Backdrop>
            <AlertDialog.Container size="md">
              <AlertDialog.Dialog>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>Delete every conversation?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="text-muted text-sm leading-6">
                    All {threads.length} conversations in this browser are removed. They are stored
                    nowhere else, so this cannot be undone.
                  </p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button variant="ghost" onPress={() => setConfirmDeleteAll(false)}>
                    Cancel
                  </Button>
                  <Button variant="danger" onPress={deleteAll}>
                    Delete all
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      ) : null}

      <ThreadRail
        activeId={threadId}
        onDelete={deleteThread}
        onDeleteAll={requestDeleteAll}
        onNewChat={startNewChat}
        onOpen={openThread}
        threads={threads}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 pb-4">
          <ModelPicker models={models} selectedId={modelId} onSelect={setModelId} />

          <div className="flex items-center gap-2 lg:hidden">
            <ThreadMenu
              activeId={threadId}
              onDelete={deleteThread}
              onDeleteAll={requestDeleteAll}
              onNewChat={startNewChat}
              onOpen={openThread}
              threads={threads}
            />
          </div>
        </header>

        {/* The blank state centres everything and the active conversation does
            not. Both references do this, and the reason is that a composer
            pinned to the bottom of an empty page reads as the footer of a page
            that failed to load. */}
        {isBlank ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
            <div className="flex w-full max-w-3xl flex-col gap-3">{notices}</div>
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-3xl leading-[1.15] font-semibold tracking-[-0.03em]">
                What do you want to ask?
              </h1>
              <p className="text-muted text-sm">
                {selectedModel
                  ? `Talking to ${selectedModel.displayName}. Switch models any time — the conversation stays.`
                  : "Pick a model to get started."}
              </p>
            </div>
            {composer}
          </div>
        ) : (
          <>
            <div
              className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
              ref={scrollRef}
            >
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-6">
                {notices}
                <Transcript
                  isStreaming={isStreaming}
                  messages={messages}
                  modelForMessage={modelForMessage}
                />
              </div>
            </div>
            <div className="pt-2">{composer}</div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Openers, as a 2x2 grid.
 *
 * Not a horizontal scroller: at this column width a row of four cards is always
 * one-and-a-bit cards too wide, so it renders a permanent scrollbar and a card
 * sliced down the middle — which reads as a layout bug rather than as an
 * invitation to scroll. Two columns fit whole at every width this column takes,
 * phone included.
 */
function Suggestions({ onSeed }: Readonly<{ onSeed: (prompt: string) => void }>) {
  return (
    <ul className="grid grid-cols-2 gap-2">
      {SUGGESTIONS.map((suggestion) => (
        <li key={suggestion.title}>
          <button
            className="border-border bg-surface hover:border-muted flex h-full w-full flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors"
            onClick={() => onSeed(suggestion.prompt)}
            type="button"
          >
            <span className="text-sm font-medium">{suggestion.title}</span>
            <span className="text-muted line-clamp-2 text-xs leading-5">{suggestion.prompt}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type RailProps = {
  activeId: string;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onNewChat: () => void;
  onOpen: (thread: ChatThread) => void;
  threads: ChatThread[];
};

/** Desktop history rail. Hidden below `lg`, where `ThreadMenu` takes over. */
function ThreadRail({
  activeId,
  onDelete,
  onDeleteAll,
  onNewChat,
  onOpen,
  threads,
}: Readonly<RailProps>) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col gap-4 lg:flex">
      {/* `w-full`: HeroUI's Button sizes to its content, so in a 224px rail it
          rendered as a 109px stub floating at the top of the column. */}
      <Button className="w-full justify-start" size="sm" variant="outline" onPress={onNewChat}>
        <PlusIcon className="size-4" />
        New chat
      </Button>

      <nav aria-label="Conversation history" className="flex min-h-0 flex-1 flex-col gap-1.5">
        {/* List-level actions belong ON the list header, next to what they act
            on. "Delete all" used to sit at the bottom of the rail under a
            privacy footnote, which is where a footnote goes and not where a
            control that erases every conversation goes. */}
        <div className="flex items-center justify-between gap-2 pr-1 pl-1">
          <span className="text-muted text-xs font-medium tracking-wide uppercase">
            Conversations
          </span>

          {threads.length > 0 ? (
            <Dropdown>
              <Dropdown.Trigger
                aria-label="Conversation list actions"
                className="text-muted hover:text-foreground rounded p-0.5 transition-colors"
              >
                <EllipsisIcon className="size-4" />
              </Dropdown.Trigger>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label="Conversation list actions"
                  onAction={() => onDeleteAll()}
                >
                  <Dropdown.Item id="delete-all">Delete all conversations</Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          ) : null}
        </div>

        {threads.length === 0 ? (
          <p className="text-muted px-1 text-xs leading-5">
            Nothing here yet. Conversations you start are listed in this column.
          </p>
        ) : (
          // No negative margin on this list: `-mx-1` made it 8px wider than the
          // 224px rail and hung a horizontal scrollbar under it.
          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {threads.map((thread) => (
              <li
                key={thread.id}
                className={`group/row flex items-center rounded-md transition-colors ${
                  thread.id === activeId ? "bg-surface" : "hover:bg-surface"
                }`}
              >
                <button
                  className={`min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm ${
                    thread.id === activeId ? "text-foreground" : "text-muted"
                  }`}
                  onClick={() => onOpen(thread)}
                  type="button"
                >
                  {thread.title}
                </button>

                {/* Revealed on hover and on keyboard focus. Always-visible bins
                    down the side of a list turn every row into a dare; a bin
                    that only appears on hover and never on focus is unreachable
                    without a mouse. */}
                <button
                  aria-label={`Delete “${thread.title}”`}
                  className="text-muted hover:text-danger mr-1 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  onClick={() => onDelete(thread.id)}
                  type="button"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {/* A footnote, and only a footnote. It explains where the list lives; it
          is not a place to hang controls. */}
      <p className="border-border text-muted border-t pt-3 text-xs leading-5">
        Kept in this browser only. The platform stores no copy.
      </p>
    </aside>
  );
}

/** The same history, as a menu, for viewports too narrow for the rail. */
function ThreadMenu({
  activeId,
  onDelete,
  onDeleteAll,
  onNewChat,
  onOpen,
  threads,
}: Readonly<RailProps>) {
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label="Conversations"
        className="border-border text-muted hover:text-foreground inline-flex h-8 items-center rounded-full border px-3 text-sm"
      >
        History
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="Conversations"
          onAction={(key) => {
            const action = String(key);
            if (action === "new") return onNewChat();
            if (action === "clear") return onDeleteAll();
            // A menu row cannot carry its own bin. Rather than double the list
            // with a delete row per conversation, the touch user gets the one
            // that matters: delete the conversation they are reading.
            if (action === "delete-current") return onDelete(activeId);
            const thread = threads.find((t) => t.id === action);
            if (thread) onOpen(thread);
          }}
        >
          <Dropdown.Item id="new">New chat</Dropdown.Item>
          {threads.map((thread) => (
            <Dropdown.Item id={thread.id} key={thread.id}>
              {thread.id === activeId ? `• ${thread.title}` : thread.title}
            </Dropdown.Item>
          ))}
          {threads.some((thread) => thread.id === activeId) ? (
            <Dropdown.Item id="delete-current">Delete this chat</Dropdown.Item>
          ) : null}
          {threads.length > 0 ? <Dropdown.Item id="clear">Delete all</Dropdown.Item> : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
