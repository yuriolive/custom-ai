/** Type surface for @custom-ai/mock-upstream. Runtime is plain JS (index.js). */

export type UsageMode = "full" | "basic" | "none";
export type UsagePlacement = "auto" | "separate" | "final";
export type FailMode = "none" | "500" | "429" | "404" | "drop" | "hang" | "malformed";

export interface MockOptions {
  /** ms to withhold the first byte (headers included). Default 0. */
  coldStartMs: number;
  /** ms between token frames. Default 0. */
  tokenDelayMs: number;
  /** number of content tokens to emit. Default 8. */
  tokens: number;
  /** full = vLLM (cached_tokens), basic = llama.cpp best case, none = no usage at all. Default "full". */
  usage: UsageMode;
  /**
   * vLLM semantics. When true, a STREAMING response emits usage only if the request
   * body carries `stream_options: { include_usage: true }`; otherwise no usage at all,
   * whatever `usage` says. Default false. Non-streaming responses are unaffected.
   */
  honorIncludeUsage: boolean;
  /** separate = extra chunk with choices:[], final = usage on the finish chunk. Default "auto". */
  usagePlacement: UsagePlacement;
  fail: FailMode;
  /** tokens emitted before fail=drop kills the socket. Default 3. */
  dropAfter: number;
  /** token index before which fail=malformed injects a bad frame. Default 2. */
  malformedAfter: number;
  promptTokens: number;
  cachedTokens: number;
  /** override the emitted token text. Default null (built-in lorem). */
  tokenText: string | null;
  finishReason: string;
  /** override the echoed model name. Default null (echo request body `model`). */
  model: string | null;
}

export interface RecordedRequest {
  at: string;
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  endpointId: string | null;
  headers: Record<string, string | string[] | undefined>;
  authorization: string | null;
  rawBody: string;
  body: any;
  bodyParseError: string | null;
  stream: boolean | undefined;
  streamOptions: unknown;
  model: string | undefined;
  messages: unknown;
  options: MockOptions;
}

export interface MockUpstream {
  /** e.g. "http://127.0.0.1:53211" — use as UPSTREAM_BASE_URL. */
  url: string;
  port: number;
  server: import("node:http").Server;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  lastRequest(): RecordedRequest | undefined;
  reset(): void;
  setDefaults(next: Partial<MockOptions>): MockOptions;
  getDefaults(): MockOptions;
  close(): Promise<void>;
}

export function startMockUpstream(config?: {
  port?: number;
  host?: string;
  defaults?: Partial<MockOptions>;
  log?: boolean;
}): Promise<MockUpstream>;

export default startMockUpstream;
