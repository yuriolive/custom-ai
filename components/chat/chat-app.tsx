"use client";

import { useChat } from "@ai-sdk/react";
import { Alert, Button, Dropdown } from "@heroui/react";
import { DefaultChatTransport } from "ai";
import type { Route } from "next";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ModelPicker } from "@/components/chat/model-picker";
import { Transcript, messageText } from "@/components/chat/transcript";
import { ColdStartNotice } from "@/components/cold-start-notice";
import type { CatalogModel } from "@/components/marketplace/types";
import { decodeChatError, parseGatewayErrorCode, presentChatError } from "@/lib/chat/errors";
import {
  clearThreads,
  createThread,
  loadThreads,
  saveThreads,
  titleFromText,
  upsertThread,
  type ChatThread,
  type StoredMessage,
} from "@/lib/chat/history";
import type { ChatUIMessage } from "@/lib/types";

const MAX_COMPOSER_ROWS = 8;
const LINE_HEIGHT_PX = 24;
const COMPOSER_PADDING_PX = 18;

/**
 * Openers for a blank chat.
 *
 * They FILL the composer; they never send. The first request of a session wakes
 * a scale-to-zero worker and takes about a minute and a half, and spending that
 * on a misclick is hostile — the same rule the playground's seed prompts follow.
 */
const SUGGESTIONS = [
  "Explain what a VPN actually does, in plain language.",
  "Help me write a polite message declining a meeting invitation.",
  "Give me a week of simple dinners for two, with a shopping list.",
  "Summarise the argument for and against nuclear power in ten lines.",
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

  const [transport] = useState(
    () => new DefaultChatTransport<ChatUIMessage>({ api: "/api/chat" }),
  );
  const { messages, sendMessage, regenerate, status, stop, error, clearError, setMessages } =
    useChat<ChatUIMessage>({ transport });

  const isSubmitted = status === "submitted"; // sent, no first token yet
  const isStreaming = status === "streaming";
  const isBusy = isSubmitted || isStreaming;

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
          existing && existing.title !== "New chat"
            ? existing.title
            : titleFromText(firstUserText),
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

  // Auto-grow the composer up to 8 rows, then scroll. HeroUI v3's TextArea is a
  // primitive <textarea>: no minRows/maxRows props exist.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = MAX_COMPOSER_ROWS * LINE_HEIGHT_PX + COMPOSER_PADDING_PX;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

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

  const deleteAll = useCallback(() => {
    clearThreads(window.localStorage);
    setThreads([]);
    startNewChat();
  }, [startNewChat]);

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

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[30rem] gap-6">
      <ThreadRail
        activeId={threadId}
        onDeleteAll={deleteAll}
        onNewChat={startNewChat}
        onOpen={openThread}
        threads={threads}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-start justify-between gap-3 pb-4">
          <ModelPicker models={models} selectedId={modelId} onSelect={setModelId} />

          {/* No "New chat" button here: the rail carries one on desktop and the
              History menu carries one below `lg`, and a third copy sitting
              between them was just a second thing to aim at. */}
          <ThreadMenu
            activeId={threadId}
            onDeleteAll={deleteAll}
            onNewChat={startNewChat}
            onOpen={openThread}
            threads={threads}
          />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1" ref={scrollRef}>
          {unavailableModelId ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>That link points at a model we cannot open</Alert.Title>
                <Alert.Description>
                  <span className="font-mono">{unavailableModelId}</span> is not on the public
                  catalog — it may have been unpublished. Another model is selected instead.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {isSubmitted && turnStartedAt !== null ? (
            <ColdStartNotice startedAt={turnStartedAt} />
          ) : null}

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
                {/* Only where sending the same thing again could actually work
                    — a timeout, not a 402. Offering "try again" on an error
                    that will repeat is how a product wastes someone's money. */}
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

          {messages.length === 0 ? (
            <EmptyState modelName={selectedModel?.displayName ?? null} onSeed={seedComposer} />
          ) : (
            <Transcript
              isStreaming={isStreaming}
              messages={messages}
              modelForMessage={modelForMessage}
            />
          )}
        </div>

        <form
          className="border-border bg-background mt-4 flex items-end gap-2 rounded-2xl border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {/* A plain <textarea>, not HeroUI's TextArea: this one sits inside the
              composer's own border, and the component's ring and background
              would draw a second box around it. */}
          <textarea
            aria-label="Message"
            className="text-foreground placeholder:text-muted max-h-[13rem] min-h-[2.75rem] flex-1 resize-none bg-transparent px-2 py-2.5 text-sm leading-6 outline-none"
            placeholder="Ask anything…  (Enter to send, Shift+Enter for a new line)"
            ref={composerRef}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {isBusy ? (
            <Button variant="danger" onPress={() => stop()}>
              Stop
            </Button>
          ) : (
            <Button isDisabled={input.trim().length === 0 || !modelId} type="submit">
              Send
            </Button>
          )}
        </form>

        <p className="text-muted mt-2 text-xs">
          Billed to your wallet per token. Conversations are kept in this browser — the platform
          stores no copy.
        </p>
      </section>
    </div>
  );
}

function EmptyState({
  modelName,
  onSeed,
}: Readonly<{
  modelName: string | null;
  onSeed: (prompt: string) => void;
}>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl leading-[1.2] font-semibold tracking-[-0.025em]">
          What do you want to ask?
        </h1>
        <p className="text-muted text-sm">
          {modelName
            ? `Talking to ${modelName}. Switch models any time — the conversation stays.`
            : "Pick a model to get started."}
        </p>
      </div>

      <ul className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((prompt) => (
          <li key={prompt}>
            <Button
              className="h-auto w-full justify-start py-2.5 text-left text-sm whitespace-normal"
              variant="secondary"
              onPress={() => onSeed(prompt)}
            >
              {prompt}
            </Button>
          </li>
        ))}
      </ul>

      <p className="text-muted max-w-md text-xs">
        Pressing one fills the box. Nothing is sent, and nothing is charged, until you press Send.
      </p>
    </div>
  );
}

type RailProps = {
  activeId: string;
  onDeleteAll: () => void;
  onNewChat: () => void;
  onOpen: (thread: ChatThread) => void;
  threads: ChatThread[];
};

/** Desktop history rail. Hidden below `lg`, where `ThreadMenu` takes over. */
function ThreadRail({ activeId, onDeleteAll, onNewChat, onOpen, threads }: Readonly<RailProps>) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-3 lg:flex">
      <Button size="sm" variant="outline" onPress={onNewChat}>
        New chat
      </Button>

      <nav aria-label="Conversation history" className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="text-muted px-1 text-xs leading-5">
            Conversations you have here will be listed in this column.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Button
                  className={[
                    "h-auto w-full justify-start px-2 py-1.5 text-left text-sm font-normal",
                    thread.id === activeId ? "bg-surface text-foreground" : "text-muted",
                  ].join(" ")}
                  size="sm"
                  variant="ghost"
                  onPress={() => onOpen(thread)}
                >
                  <span className="w-full truncate">{thread.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {threads.length > 0 ? (
        <div className="border-border flex flex-col gap-2 border-t pt-3">
          <p className="text-muted text-xs leading-5">
            Stored in this browser only. Clearing site data clears them.
          </p>
          <Button size="sm" variant="ghost" onPress={onDeleteAll}>
            Delete all conversations
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

/** The same history, as a menu, for viewports too narrow for the rail. */
function ThreadMenu({ activeId, onDeleteAll, onNewChat, onOpen, threads }: Readonly<RailProps>) {
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label="Conversations"
        className="border-border text-muted hover:text-foreground inline-flex h-8 items-center rounded-md border px-2.5 text-sm lg:hidden"
      >
        History
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="Conversations"
          onAction={(key) => {
            if (key === "new") return onNewChat();
            if (key === "clear") return onDeleteAll();
            const thread = threads.find((t) => t.id === key);
            if (thread) onOpen(thread);
          }}
        >
          <Dropdown.Item id="new">New chat</Dropdown.Item>
          {threads.map((thread) => (
            <Dropdown.Item id={thread.id} key={thread.id}>
              {thread.id === activeId ? `• ${thread.title}` : thread.title}
            </Dropdown.Item>
          ))}
          {threads.length > 0 ? <Dropdown.Item id="clear">Delete all</Dropdown.Item> : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
