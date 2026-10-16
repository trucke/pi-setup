/**
 * Local CLIProxyAPI stand-in for tests. It follows CPA's documented WebSocket behavior for HTTP
 * upstreams: per connection it keeps the last request and response output, expands
 * `previous_response_id` requests to the full input, and merges a later request without
 * assistant items into the stale history. Nothing here describes what CPA's upstreams do.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { NodeWS } from "@effect/platform-node/NodeSocket";

type Json = { readonly [key: string]: unknown };

export interface Reply {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCall?: { readonly name: string; readonly arguments: string };
}

export interface RecordedRequest {
  readonly transport: "websocket" | "sse" | "anthropic";
  readonly connection?: number;
  readonly delta: boolean;
  /** The input CPA would send upstream after its own merge. */
  readonly merged: readonly unknown[];
  readonly body: Json;
  readonly path: string;
}

export interface Faults {
  /** HTTP status for the next WebSocket upgrades. */
  rejectUpgrade?: number;
  /** Close the socket with this code after the next request arrives, before any event. */
  closeAfterRequest?: number;
  /** Answer the next continuation with `previous_response_not_found`. */
  forgetContinuation?: boolean;
  /** Never answer the next request. */
  stall?: boolean;
}

export interface MockCpa {
  readonly root: string;
  readonly requests: RecordedRequest[];
  readonly faults: Faults;
  connections: number;
  modelsResponse: unknown;
  richResponse: unknown;
  close(): Promise<void>;
}

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasHistory(input: readonly unknown[]): boolean {
  return input.some(
    (item) =>
      isJson(item) &&
      (item.type === "function_call" ||
        item.type === "custom_tool_call" ||
        (item.type === "message" && item.role === "assistant")),
  );
}

let counter = 0;

export function responseEvents(reply: Reply): {
  events: Json[];
  output: Json[];
  id: string;
} {
  const n = ++counter;
  const id = `resp_${n}`;
  const output: Json[] = [];
  if (reply.reasoning !== undefined) {
    output.push({
      type: "reasoning",
      id: `rs_${n}`,
      summary: [{ type: "summary_text", text: reply.reasoning }],
      encrypted_content: `enc_${n}`,
    });
  }
  if (reply.text !== undefined) {
    output.push({
      type: "message",
      id: `msg_${n}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    });
  }
  if (reply.toolCall) {
    output.push({
      type: "function_call",
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: reply.toolCall.name,
      arguments: reply.toolCall.arguments,
      status: "completed",
    });
  }
  const events: Json[] = [
    {
      type: "response.created",
      response: { id, status: "in_progress", output: [] },
    },
  ];
  output.forEach((item, index) => {
    const added =
      item.type === "message"
        ? { ...item, content: [] }
        : item.type === "function_call"
          ? { ...item, arguments: "" }
          : { ...item, summary: [] };
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: added,
    });
    if (item.type === "reasoning") {
      events.push({
        type: "response.reasoning_summary_text.delta",
        output_index: index,
        delta: reply.reasoning,
      });
    } else if (item.type === "message") {
      events.push({
        type: "response.output_text.delta",
        output_index: index,
        delta: reply.text,
      });
    } else {
      events.push({
        type: "response.function_call_arguments.delta",
        output_index: index,
        delta: item.arguments,
      });
      events.push({
        type: "response.function_call_arguments.done",
        output_index: index,
        arguments: item.arguments,
      });
    }
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  });
  events.push({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: {
        input_tokens: 125,
        output_tokens: 12,
        total_tokens: 137,
        input_tokens_details: { cached_tokens: 100 },
      },
    },
  });
  return { events, output, id };
}

function anthropicEvents(text: string): string {
  const frames: [string, Json][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_a1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 25,
            output_tokens: 0,
            cache_read_input_tokens: 100,
          },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return frames
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isJson(value) ? value : {};
}

export async function startMockCpa(options: {
  readonly apiKey: string;
  readonly reply: (merged: readonly unknown[], body: Json) => Reply;
  readonly models?: readonly { id: string; owned_by?: string }[];
  readonly rich?: readonly Json[];
}): Promise<MockCpa> {
  const authorized = (request: IncomingMessage) =>
    request.headers.authorization === `Bearer ${options.apiKey}` ||
    request.headers["x-api-key"] === options.apiKey;

  const mock: MockCpa = {
    root: "",
    requests: [],
    faults: {},
    connections: 0,
    modelsResponse: {
      object: "list",
      data: (options.models ?? []).map((model) => ({
        object: "model",
        ...model,
      })),
    },
    richResponse: options.rich ? { models: options.rich } : undefined,
    close: async () => undefined,
  };

  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!authorized(request))
      return json(response, 401, { error: { message: "unauthorized" } });
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(
        response,
        200,
        url.searchParams.has("client_version") && mock.richResponse
          ? mock.richResponse
          : mock.modelsResponse,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const body = await readBody(request);
      const input = Array.isArray(body.input) ? body.input : [];
      mock.requests.push({
        transport: "sse",
        delta: false,
        merged: input,
        body,
        path: url.pathname,
      });
      const { events } = responseEvents(options.reply(input, body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events)
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readBody(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      mock.requests.push({
        transport: "anthropic",
        delta: false,
        merged: messages,
        body,
        path: url.pathname,
      });
      const reply = options.reply(messages, body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.end(anthropicEvents(reply.text ?? ""));
    }
    json(response, 404, { error: { message: `no route ${url.pathname}` } });
  });

  const wss = new NodeWS.WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const status =
      mock.faults.rejectUpgrade ?? (authorized(request) ? undefined : 401);
    if (url.pathname !== "/v1/responses" || status !== undefined) {
      socket.end(
        `HTTP/1.1 ${status ?? 404} Rejected\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = ++mock.connections;
      let last:
        | { input: readonly unknown[]; output: readonly unknown[]; id: string }
        | undefined;
      ws.on("message", (data) => {
        const parsed: unknown = JSON.parse(data.toString());
        if (!isJson(parsed) || parsed.type !== "response.create") return;
        const { type: _type, previous_response_id: previous, ...body } = parsed;
        const input = Array.isArray(body.input) ? body.input : [];
        if (mock.faults.closeAfterRequest !== undefined) {
          const code = mock.faults.closeAfterRequest;
          delete mock.faults.closeAfterRequest;
          ws.close(
            code,
            code === 1012 ? "upstream requires HTTP replay" : "test close",
          );
          return;
        }
        if (mock.faults.stall) {
          delete mock.faults.stall;
          return;
        }
        let merged: readonly unknown[];
        if (typeof previous === "string") {
          if (!last || previous !== last.id || mock.faults.forgetContinuation) {
            delete mock.faults.forgetContinuation;
            ws.send(
              JSON.stringify({
                type: "error",
                status: 409,
                error: {
                  type: "invalid_request_error",
                  code: "previous_response_not_found",
                  message:
                    "Previous response is not available on this websocket",
                },
              }),
            );
            return;
          }
          merged = [...last.input, ...last.output, ...input];
        } else {
          merged =
            last && !hasHistory(input)
              ? [...last.input, ...last.output, ...input]
              : input;
        }
        mock.requests.push({
          transport: "websocket",
          connection,
          delta: typeof previous === "string",
          merged,
          body,
          path: url.pathname,
        });
        const { events, output, id } = responseEvents(
          options.reply(merged, body),
        );
        for (const event of events) ws.send(JSON.stringify(event));
        last = { input: merged, output, id };
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return Object.assign(mock, {
    root: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
