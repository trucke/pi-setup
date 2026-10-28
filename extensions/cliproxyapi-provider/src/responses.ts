import { createHash } from "node:crypto";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import {
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Data, Effect, Exit, Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import { redactSecret } from "./redact.ts";

type ResponsesModel = Model<"openai-responses">;
type FetchFunction = typeof globalThis.fetch;
type JsonObject = { readonly [key: string]: unknown };

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const WRITE_TIMEOUT_MS = 10_000;
const SESSION_IDLE_CLOSE_MS = 5 * 60_000;
const HANDSHAKE_RETRY_MS = 5 * 60_000;
/** CPA closes with 1012 when an upstream continuation needs a full replay. */
const REPLAY_REQUIRED_CLOSE = 1012;
const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "error",
]);
const RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);
/** Output items Pi stores on the assistant message and replays in the next request. */
const REPLAYED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "message",
  "function_call",
  "custom_tool_call",
]);
const HOP_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
];

class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly phase: "connect" | "stream";
  readonly closeCode?: number;
}> {}

/** CPA never received the request, so it can be sent again elsewhere. */
class Undelivered extends Data.TaggedError("Undelivered")<{
  readonly cause: TransportError;
  readonly reusedConnection: boolean;
}> {}

/** CPA explicitly asked for the full history instead of this continuation. */
class ContinuationRejected extends Data.TaggedError("ContinuationRejected")<{
  readonly reason: string;
}> {}

interface Connection {
  readonly scope: Scope.Closeable;
  readonly reader: Socket.Reader;
  readonly writer: Socket.Writer;
  readonly socket: NodeWS.WebSocket;
}

/**
 * The last completed exchange on a connection. The request is serialized when it is sent, so
 * later changes to shared objects cannot make a different request look like a continuation.
 */
export interface Continuation {
  /** The request without `input` and `previous_response_id`. */
  readonly options: string;
  readonly input: readonly string[];
  /** Output items CPA reported, as Pi will replay them. */
  readonly output: readonly JsonObject[];
  readonly responseId: string;
}

interface SessionStats {
  requests: number;
  fullRequests: number;
  deltaRequests: number;
  connectionsOpened: number;
  sseRequests: number;
  lastFallback?: string;
  lastError?: string;
}

interface SessionEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly modelId: string;
  connection?: Connection;
  continuation?: Continuation;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
  websocketRetryAt?: number;
  readonly stats: SessionStats;
}

export interface TransportSessionStatus {
  readonly sessionId: string;
  readonly modelId: string;
  readonly connected: boolean;
  readonly continuation: boolean;
  readonly websocketPausedUntil?: number;
  readonly stats: Readonly<SessionStats>;
}

export interface ResponsesTransport {
  readonly stream: (
    model: ResponsesModel,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => AssistantMessageEventStream;
  readonly streamSimple: (
    model: ResponsesModel,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  /** Close connections and forget continuations for one session, or for all when omitted. */
  readonly closeSession: (sessionId?: string) => void;
  readonly status: () => readonly TransportSessionStatus[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestOptions(body: JsonObject): string {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return JSON.stringify(rest);
}

/** The text of a message holding exactly one `output_text` part, as Pi replays it. */
function singleOutputText(item: JsonObject): string | undefined {
  const content = item.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const [part] = content;
  return isObject(part) &&
    part.type === "output_text" &&
    typeof part.text === "string"
    ? part.text
    : undefined;
}

function texts(value: unknown): string | undefined {
  if (value === undefined || value === null) return "[]";
  if (!Array.isArray(value)) return undefined;
  return JSON.stringify(
    value.map((part) => (isObject(part) ? part.text : undefined)),
  );
}

function sameJsonText(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

const optional = (value: unknown) => (value === null ? undefined : value);

/**
 * Whether Pi's replayed input item is the output item CPA produced. Deliberately strict: any
 * difference means the local history diverged, and a full request is the safe answer.
 */
function replays(item: unknown, produced: JsonObject): boolean {
  if (!isObject(item) || item.type !== produced.type) return false;
  switch (produced.type) {
    case "reasoning": {
      const summary = texts(produced.summary);
      const content = texts(produced.content);
      return (
        item.id === produced.id &&
        optional(item.encrypted_content) ===
          optional(produced.encrypted_content) &&
        summary !== undefined &&
        summary === texts(item.summary) &&
        content !== undefined &&
        content === texts(item.content)
      );
    }
    case "message": {
      const text = singleOutputText(produced);
      return (
        text !== undefined &&
        item.role === "assistant" &&
        produced.role === "assistant" &&
        item.id === produced.id &&
        optional(item.phase) === optional(produced.phase) &&
        singleOutputText(item) === text
      );
    }
    case "function_call":
      return (
        item.id === produced.id &&
        item.call_id === produced.call_id &&
        item.name === produced.name &&
        optional(item.namespace) === optional(produced.namespace) &&
        sameJsonText(item.arguments, produced.arguments)
      );
    case "custom_tool_call":
      return (
        item.id === produced.id &&
        item.call_id === produced.call_id &&
        item.name === produced.name &&
        optional(item.namespace) === optional(produced.namespace) &&
        typeof item.input === "string" &&
        item.input === produced.input
      );
    default:
      return false;
  }
}

/**
 * Input items to append when `body` extends the last completed exchange on this connection:
 * identical options, the previous input as an exact prefix, then that response's output.
 */
export function continuationDelta(
  body: JsonObject,
  continuation: Continuation,
): readonly unknown[] | undefined {
  const input = body.input;
  if (!Array.isArray(input)) return undefined;
  if (requestOptions(body) !== continuation.options) return undefined;
  const outputStart = continuation.input.length;
  const deltaStart = outputStart + continuation.output.length;
  if (input.length <= deltaStart) return undefined;
  for (let index = 0; index < outputStart; index++) {
    if (JSON.stringify(input[index]) !== continuation.input[index]) {
      return undefined;
    }
  }
  for (let index = 0; index < continuation.output.length; index++) {
    const produced = continuation.output[index];
    if (!produced || !replays(input[outputStart + index], produced)) {
      return undefined;
    }
  }
  return input.slice(deltaStart);
}

function socketErrorMessage(error: Socket.SocketError): string {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError") {
    // Pi retries transient failures by their message and recognizes "WebSocket closed", which
    // its own WebSocket transport reports. A bare code such as "WebSocket 1000" reads as final.
    return `WebSocket closed before the response completed (${reason.message})`;
  }
  if (reason._tag === "SocketOpenError" && reason.kind === "Unknown") {
    const cause: unknown = reason.cause;
    if (isObject(cause) && typeof cause.message === "string" && cause.message) {
      return cause.message;
    }
  }
  return `WebSocket ${reason.message}`;
}

function toTransportError(
  error: Socket.SocketError,
  phase: TransportError["phase"],
): TransportError {
  return new TransportError({
    message: socketErrorMessage(error),
    phase,
    ...(error.reason._tag === "SocketCloseError"
      ? { closeCode: error.reason.code }
      : {}),
  });
}

function openConnection(
  url: string,
  headers: Record<string, string>,
  connectTimeoutMs: number,
): Effect.Effect<Connection, TransportError> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    let raw: NodeWS.WebSocket | undefined;
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() => {
          raw = new NodeWS.WebSocket(url, { headers });
          return raw;
        }),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
      { openTimeout: connectTimeoutMs > 0 ? connectTimeoutMs : "1 day" },
    );
    const opened = yield* Effect.all({
      reader: socket.reader,
      writer: socket.writer,
    }).pipe(
      Scope.provide(scope),
      Effect.mapError((error) => toTransportError(error, "connect")),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    if (!raw) {
      return yield* new TransportError({
        message: "WebSocket was not created",
        phase: "connect",
      });
    }
    return { scope, ...opened, socket: raw };
  });
}

function closeConnection(connection: Connection | undefined): void {
  if (connection) Effect.runFork(Scope.close(connection.scope, Exit.void));
}

/** One CPA WebSocket frame as a Responses event, with Codex-only spellings normalized. */
function parseFrame(frame: Uint8Array | string): JsonObject | undefined {
  const text =
    typeof frame === "string" ? frame : new TextDecoder().decode(frame);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      type: "error",
      error: { message: "CPA sent an invalid WebSocket frame" },
    };
  }
  if (!isObject(value) || typeof value.type !== "string") return undefined;
  if (
    value.type !== "response.done" &&
    value.type !== "response.completed" &&
    value.type !== "response.incomplete"
  ) {
    return value;
  }
  const response = isObject(value.response) ? value.response : {};
  const status =
    typeof response.status === "string" &&
    RESPONSE_STATUSES.has(response.status)
      ? response.status
      : undefined;
  // Codex upstreams end turns with `response.done`; Pi expects `response.completed`.
  return {
    ...value,
    type: value.type === "response.done" ? "response.completed" : value.type,
    response: { ...response, status },
  };
}

function errorCode(event: JsonObject): string | undefined {
  if (typeof event.code === "string") return event.code;
  return isObject(event.error) && typeof event.error.code === "string"
    ? event.error.code
    : undefined;
}

function requestUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Headers from Pi's HTTP request that also apply to the WebSocket handshake. */
function handshakeHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    if (!HOP_HEADERS.includes(name)) headers[name] = value;
  });
  return headers;
}

export function createResponsesTransport(settings: {
  readonly root: string;
  readonly websocket: boolean;
}): ResponsesTransport {
  const websocketUrl = (() => {
    const url = new URL(`${settings.root}/v1/responses`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  })();
  const responsesUrl = new URL(`${settings.root}/v1/responses`);
  // A model-level baseUrl override points elsewhere; only CPA's own endpoint is carried here.
  const isConfiguredEndpoint = (url: string) => {
    try {
      const target = new URL(url);
      return (
        target.origin === responsesUrl.origin &&
        target.pathname === responsesUrl.pathname
      );
    } catch {
      return false;
    }
  };
  const sse = openAIResponsesApi();
  const sessions = new Map<string, SessionEntry>();

  const forget = (entry: SessionEntry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    closeConnection(entry.connection);
    entry.connection = undefined;
    entry.continuation = undefined;
  };

  const release = (entry: SessionEntry) => {
    entry.busy = false;
    if (!entry.connection) return;
    entry.idleTimer = setTimeout(() => {
      if (!entry.busy) forget(entry);
    }, SESSION_IDLE_CLOSE_MS);
    entry.idleTimer.unref();
  };

  const entryFor = (
    authorization: string,
    sessionId: string,
    modelId: string,
  ): SessionEntry => {
    // Hashing keeps raw credentials out of long-lived map keys.
    const authId = createHash("sha256")
      .update(authorization)
      .digest("hex")
      .slice(0, 16);
    const key = `${authId}\0${sessionId}\0${modelId}`;
    let entry = sessions.get(key);
    if (!entry) {
      entry = {
        key,
        sessionId,
        modelId,
        busy: false,
        stats: {
          requests: 0,
          fullRequests: 0,
          deltaRequests: 0,
          connectionsOpened: 0,
          sseRequests: 0,
        },
      };
      sessions.set(key, entry);
    }
    return entry;
  };

  /**
   * Send one request over the session's WebSocket and resolve once CPA answered, so a request CPA
   * never received or explicitly rejected can still be resent. Rejects with `Undelivered` only
   * when nothing reached CPA.
   */
  const send = async (
    entry: SessionEntry,
    body: JsonObject,
    init: RequestInit,
    options: StreamOptions | undefined,
    secret: string,
    onAbandon: (finish: () => void) => void,
  ): Promise<Response> => {
    const signal = init.signal ?? undefined;
    const runOptions = signal ? { signal } : undefined;
    const cacheable = options?.transport !== "websocket";
    const idleTimeoutMs = options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const pull = (connection: Connection) => {
      const read = connection.reader.pull.pipe(
        Effect.mapError((error) => toTransportError(error, "stream")),
      );
      return idleTimeoutMs > 0
        ? read.pipe(
            Effect.timeoutOrElse({
              duration: idleTimeoutMs,
              orElse: () =>
                Effect.fail(
                  new TransportError({
                    message: `WebSocket idle for ${idleTimeoutMs}ms`,
                    phase: "stream",
                  }),
                ),
            }),
          )
        : read;
    };

    const attempt = async (allowDelta: boolean) => {
      const reused = entry.connection;
      const delta =
        allowDelta &&
        cacheable &&
        reused?.socket.readyState === NodeWS.WebSocket.OPEN &&
        entry.continuation
          ? continuationDelta(body, entry.continuation)
          : undefined;
      const previous = delta ? entry.continuation : undefined;
      let connection: Connection;
      if (delta && previous && reused) {
        connection = reused;
      } else {
        // Full requests always use a fresh connection: CPA merges input with the previous turn
        // of a connection, so reusing one could duplicate history it already holds.
        forget(entry);
        const opened = await Effect.runPromiseExit(
          openConnection(
            websocketUrl,
            handshakeHeaders(init),
            options?.websocketConnectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          ),
          runOptions,
        );
        if (Exit.isFailure(opened)) {
          if (signal?.aborted) throw new Error("Request was aborted");
          const cause = opened.cause.reasons.find(
            (reason) => reason._tag === "Fail",
          );
          throw new Undelivered({
            cause:
              cause?._tag === "Fail"
                ? cause.error
                : new TransportError({
                    message: "WebSocket connect failed",
                    phase: "connect",
                  }),
            reusedConnection: false,
          });
        }
        connection = opened.value;
        entry.connection = connection;
        entry.stats.connectionsOpened++;
      }
      entry.continuation = undefined;

      const input = Array.isArray(body.input) ? body.input : undefined;
      const sent = input
        ? {
            options: requestOptions(body),
            input: input.map((item) => JSON.stringify(item)),
          }
        : undefined;
      const frame = JSON.stringify(
        delta && previous
          ? {
              type: "response.create",
              ...body,
              previous_response_id: previous.responseId,
              input: delta,
            }
          : { type: "response.create", ...body },
      );
      const written = await Effect.runPromiseExit(
        connection.writer.write(frame).pipe(
          Effect.mapError((error) => toTransportError(error, "stream")),
          Effect.timeoutOrElse({
            duration: WRITE_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new TransportError({
                  message: "WebSocket write timed out",
                  phase: "stream",
                }),
              ),
          }),
        ),
        runOptions,
      );
      if (Exit.isFailure(written)) {
        forget(entry);
        if (signal?.aborted) throw new Error("Request was aborted");
        const cause = written.cause.reasons.find(
          (reason) => reason._tag === "Fail",
        );
        throw new Undelivered({
          cause:
            cause?._tag === "Fail"
              ? cause.error
              : new TransportError({
                  message: "WebSocket write failed",
                  phase: "stream",
                }),
          reusedConnection: delta !== undefined,
        });
      }
      entry.stats.requests++;
      if (delta) entry.stats.deltaRequests++;
      else entry.stats.fullRequests++;

      // Wait for CPA's first answer before handing the stream to Pi.
      const first = await Effect.runPromiseExit(pull(connection), runOptions);
      if (Exit.isFailure(first)) {
        forget(entry);
        if (signal?.aborted) throw new Error("Request was aborted");
        const cause = first.cause.reasons.find(
          (reason) => reason._tag === "Fail",
        );
        const error = cause?._tag === "Fail" ? cause.error : undefined;
        if (delta && error?.closeCode === REPLAY_REQUIRED_CLOSE) {
          throw new ContinuationRejected({
            reason: "CPA requires a full replay",
          });
        }
        // CPA may have accepted the turn; resending could duplicate it.
        throw new Error(
          redactSecret(
            error?.message ?? "WebSocket closed before CPA answered",
            secret,
          ),
        );
      }
      const frames = [...first.value];
      const firstEvent = frames
        .map(parseFrame)
        .find((event) => event !== undefined);
      if (
        delta &&
        firstEvent?.type === "error" &&
        errorCode(firstEvent) === "previous_response_not_found"
      ) {
        forget(entry);
        throw new ContinuationRejected({
          reason: "CPA no longer has the previous response",
        });
      }
      return { connection, frames, sent };
    };

    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(true);
    } catch (error) {
      const resend =
        error instanceof ContinuationRejected ||
        (error instanceof Undelivered && error.reusedConnection);
      if (!resend) throw error;
      entry.stats.lastFallback =
        error instanceof ContinuationRejected
          ? `${error.reason}; resent full history`
          : "connection lost before sending; resent full history";
      result = await attempt(false);
    }

    const { connection, sent } = result;
    let pending: readonly (Uint8Array | string)[] = result.frames;
    const produced: JsonObject[] = [];
    let completed: { id: string; output: readonly JsonObject[] } | undefined;
    let finished = false;
    const encoder = new TextEncoder();

    const finish = (keepConnection: boolean) => {
      if (finished) return;
      finished = true;
      if (!keepConnection) forget(entry);
      else if (completed && sent && cacheable) {
        entry.continuation = {
          options: sent.options,
          input: sent.input,
          output: completed.output,
          responseId: completed.id,
        };
      }
      release(entry);
    };
    // Pi may settle without draining the body, for example when an onResponse hook throws.
    onAbandon(() => finish(false));

    const handle = (event: JsonObject): boolean => {
      if (event.type === "response.output_item.done" && isObject(event.item)) {
        produced.push(event.item);
      }
      if (event.type !== "response.completed") {
        return (
          typeof event.type === "string" && TERMINAL_EVENTS.has(event.type)
        );
      }
      const response = isObject(event.response) ? event.response : {};
      if (typeof response.id === "string" && response.status === "completed") {
        const output = Array.isArray(response.output)
          ? response.output.filter(isObject)
          : produced;
        completed = {
          id: response.id,
          // Copy so later mutation of parsed events cannot change the stored continuation.
          output: structuredClone(
            output.filter(
              (item) =>
                typeof item.type === "string" &&
                REPLAYED_ITEM_TYPES.has(item.type),
            ),
          ),
        };
      }
      return true;
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          while (pending.length === 0) {
            pending = await Effect.runPromise(pull(connection), runOptions);
          }
          const batch = pending;
          pending = [];
          for (const frame of batch) {
            const event = parseFrame(frame);
            if (!event) continue;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
            if (handle(event)) {
              // Errors end the request; CPA keeps no usable continuation for it.
              finish(
                event.type === "response.completed" ||
                  event.type === "response.incomplete",
              );
              controller.close();
              return;
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          entry.stats.lastError = redactSecret(message, secret);
          finish(false);
          controller.error(new Error(redactSecret(message, secret)));
        }
      },
      cancel: () => finish(false),
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  /**
   * Pi's own Responses adapter builds, hooks and parses the request; this fetch only carries it
   * over CPA's WebSocket. Anything it cannot carry goes to the HTTP endpoint unchanged.
   */
  const websocketFetch =
    (
      model: ResponsesModel,
      options: StreamOptions | undefined,
      sessionId: string,
      onAbandon: (finish: () => void) => void,
    ): FetchFunction =>
    async (input, init) => {
      const http = options?.fetch ?? globalThis.fetch;
      if (
        !init ||
        init.method !== "POST" ||
        typeof init.body !== "string" ||
        !isConfiguredEndpoint(requestUrl(input))
      ) {
        return http(input, init);
      }
      let body: unknown;
      try {
        body = JSON.parse(init.body);
      } catch {
        return http(input, init);
      }
      const authorization =
        new Headers(init.headers).get("authorization") ?? "";
      if (!isObject(body) || !authorization) return http(input, init);

      const secret = options?.apiKey ?? authorization;
      const entry = entryFor(authorization, sessionId, model.id);
      if (entry.busy) {
        // A concurrent request in the same session must not disturb the connection state.
        entry.stats.sseRequests++;
        entry.stats.lastFallback = "concurrent request used SSE";
        return http(input, init);
      }
      if (
        entry.websocketRetryAt !== undefined &&
        Date.now() < entry.websocketRetryAt
      ) {
        entry.stats.sseRequests++;
        return http(input, init);
      }
      entry.busy = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try {
        const response = await send(
          entry,
          body,
          init,
          options,
          secret,
          onAbandon,
        );
        entry.websocketRetryAt = undefined;
        return response;
      } catch (error) {
        forget(entry);
        release(entry);
        if (!(error instanceof Undelivered)) {
          entry.stats.lastError = redactSecret(
            error instanceof Error ? error.message : String(error),
            secret,
          );
          throw error;
        }
        // Nothing reached CPA, so the same request over HTTP cannot duplicate a turn.
        if (error.cause.phase === "connect") {
          entry.websocketRetryAt = Date.now() + HANDSHAKE_RETRY_MS;
        }
        entry.stats.sseRequests++;
        entry.stats.lastFallback = redactSecret(
          `WebSocket ${error.cause.phase} failed: ${error.cause.message}`,
          secret,
        );
        return http(input, init);
      }
    };

  /** Route one Pi request through the WebSocket fetch and release its session when Pi settles. */
  const run = <O extends StreamOptions>(
    model: ResponsesModel,
    options: O | undefined,
    start: (options: O | undefined) => AssistantMessageEventStream,
  ): AssistantMessageEventStream => {
    const sessionId = options?.sessionId;
    if (
      !options ||
      !settings.websocket ||
      options.transport === "sse" ||
      !sessionId
    ) {
      return start(options);
    }
    const pending: (() => void)[] = [];
    const stream = start({
      ...options,
      fetch: websocketFetch(model, options, sessionId, (finish) =>
        pending.push(finish),
      ),
    });
    const settle = () => {
      for (const finish of pending) finish();
    };
    void stream.result().then(settle, settle);
    return stream;
  };

  return {
    stream: (model, context, options) =>
      run(model, options, (next) => sse.stream(model, context, next)),
    streamSimple: (model, context, options) =>
      run(model, options, (next) => sse.streamSimple(model, context, next)),
    closeSession: (sessionId) => {
      for (const entry of sessions.values()) {
        if (sessionId === undefined || entry.sessionId === sessionId) {
          forget(entry);
          sessions.delete(entry.key);
        }
      }
    },
    status: () =>
      [...sessions.values()].map((entry) => ({
        sessionId: entry.sessionId,
        modelId: entry.modelId,
        connected:
          entry.connection?.socket.readyState === NodeWS.WebSocket.OPEN,
        continuation: entry.continuation !== undefined,
        ...(entry.websocketRetryAt !== undefined &&
        entry.websocketRetryAt > Date.now()
          ? { websocketPausedUntil: entry.websocketRetryAt }
          : {}),
        stats: { ...entry.stats },
      })),
  };
}
