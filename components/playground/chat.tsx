"use client";

import { useChat } from "@ai-sdk/react";
import { Alert, Button, Card, Label, Slider, TextArea } from "@heroui/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { ColdStartNotice } from "@/components/playground/cold-start-notice";
import { MessageList } from "@/components/playground/message-list";
import { publicEnv } from "@/lib/public-env";
import type { PlaygroundUIMessage } from "@/lib/types";

const MAX_COMPOSER_ROWS = 8;
const LINE_HEIGHT_PX = 24;
const COMPOSER_PADDING_PX = 18;

export function Chat({ model }: { model: string }) {
  const [input, setInput] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The transport is created once; per-turn parameters ride on sendMessage's
  // `body` so a slider moved mid-conversation applies to the next turn.
  const [transport] = useState(
    () => new DefaultChatTransport<PlaygroundUIMessage>({ api: "/api/playground" }),
  );

  const { messages, sendMessage, status, stop, error, clearError, setMessages } =
    useChat<PlaygroundUIMessage>({ transport });

  const isSubmitted = status === "submitted"; // sent, no first token yet
  const isStreaming = status === "streaming";
  const isBusy = isSubmitted || isStreaming;

  // Auto-grow the composer up to 8 rows, then scroll (FR-PLAY-002). HeroUI v3's
  // TextArea is a primitive <textarea> — it has no minRows/maxRows props.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = MAX_COMPOSER_ROWS * LINE_HEIGHT_PX + COMPOSER_PADDING_PX;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy) return;
    clearError();
    setTurnStartedAt(Date.now());
    setInput("");
    void sendMessage(
      { text },
      { body: { model, temperature, maxTokens, systemPrompt: systemPrompt || undefined } },
    );
  }, [clearError, input, isBusy, maxTokens, model, sendMessage, systemPrompt, temperature]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="flex min-w-0 flex-col gap-4">
        {isSubmitted && turnStartedAt !== null ? (
          <ColdStartNotice startedAt={turnStartedAt} />
        ) : null}

        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>The request failed</Alert.Title>
              <Alert.Description>
                {error.message || "The gateway did not return a response."} Your message is still in
                the composer — nothing was lost.
              </Alert.Description>
            </Alert.Content>
            <Button size="sm" variant="danger" onPress={() => clearError()}>
              Dismiss
            </Button>
          </Alert>
        ) : null}

        <MessageList isStreaming={isStreaming} messages={messages} />

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <TextArea
            aria-label="Message the model"
            className="min-h-[3.25rem] flex-1 resize-none"
            fullWidth
            placeholder="Message the model…  (Enter to send, Shift+Enter for a newline)"
            ref={composerRef}
            rows={2}
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
            <Button isDisabled={input.trim().length === 0} type="submit">
              Send
            </Button>
          )}
        </form>

        {messages.length > 0 ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setMessages([]);
                clearError();
              }}
            >
              Clear conversation
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="flex flex-col gap-6">
        <Card>
          <Card.Header>
            <Card.Title>Parameters</Card.Title>
            <Card.Description>Applied to the next turn.</Card.Description>
          </Card.Header>

          <Card.Content className="flex flex-col gap-6">
            <Slider
              className="w-full"
              maxValue={2}
              minValue={0}
              step={0.05}
              value={temperature}
              onChange={(value) => setTemperature(value as number)}
            >
              <Label>Temperature</Label>
              <Slider.Output />
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>

            <Slider
              className="w-full"
              maxValue={8192}
              minValue={1}
              step={1}
              value={maxTokens}
              onChange={(value) => setMaxTokens(value as number)}
            >
              <Label>Max tokens</Label>
              <Slider.Output />
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>

            <div className="flex flex-col gap-2">
              <Label htmlFor="system-prompt">System prompt</Label>
              <TextArea
                aria-label="System prompt"
                fullWidth
                id="system-prompt"
                placeholder="Optional. Sent as the system message."
                rows={4}
                value={systemPrompt}
                variant="secondary"
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </div>
          </Card.Content>
        </Card>

        <p className="text-muted text-xs leading-5">
          Cold start is roughly {publicEnv.coldStartEstimateSeconds}s on the first request.
          Subsequent requests hit a warm worker.
        </p>
      </aside>
    </div>
  );
}
