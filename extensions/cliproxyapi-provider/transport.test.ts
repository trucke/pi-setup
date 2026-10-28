import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createModels,
  InMemoryModelsStore,
  retryAssistantCall,
  Type,
  type AssistantMessage,
  type Message,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { startMockCpa, type Reply } from "./mock-cpa.ts";
import { createProxyProvider } from "./src/provider.ts";

type Json = { readonly [key: string]: unknown };
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tools: Tool[] = [
  {
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({
      text: Type.String(),
      note: Type.Optional(Type.String()),
    }),
  },
];

function lastUserText(items: readonly unknown[]): string {
  for (const item of [...items].reverse()) {
    if (!isJson(item) || item.role !== "user") continue;
    const content = item.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) => (isJson(part) ? String(part.text ?? "") : ""))
        .join("");
  }
  return "";
}

/** Answers from the history CPA would send upstream, so wrong merges change the reply. */
function scripted(items: readonly unknown[]): Reply {
  const last = items.at(-1);
  if (isJson(last) && last.type === "function_call_output")
    return { text: `done: ${String(last.output)} ✓` };
  if (
    isJson(last) &&
    last.role === "user" &&
    Array.isArray(last.content) &&
    last.content.length === 0
  )
    return { text: "" };
  const text = lastUserText(items);
  if (text.includes("tool")) {
    return {
      reasoning: "thinking…",
      toolCall: {
        name: "echo",
        arguments: JSON.stringify({ text: "héllo 🌍", note: null }),
      },
    };
  }
  return { text: `reply to ${text} 👋` };
}

let fixtures = 0;

async function fixture(t: TestContext, options: { websocket?: boolean } = {}) {
  const key = `key-${++fixtures}`;
  const env = `CPA_TRANSPORT_TEST_KEY_${fixtures}`;
  process.env[env] = key;
  const mock = await startMockCpa({
    apiKey: key,
    models: [{ id: "gpt-6.1-sol" }, { id: "claude-opus-5-5" }],
    reply: scripted,
  });
  const proxy = createProxyProvider({
    path: "test",
    provider: "proxy",
    name: "CLIProxyAPI",
    root: mock.root,
    apiKeyEnv: env,
    websocket: options.websocket ?? true,
    routes: {},
  });
  const collection = createModels({ modelsStore: new InMemoryModelsStore() });
  collection.setProvider(proxy.provider);
  assert.equal(
    (await collection.refresh({ allowNetwork: true })).errors.size,
    0,
  );
  t.after(async () => {
    proxy.transport.closeSession();
    delete process.env[env];
    await mock.close();
  });
  const model = (id = "gpt-6.1-sol") => {
    const found = collection.getModel("proxy", id);
    assert.ok(found, id);
    return found;
  };
  const turn = (
    messages: Message[],
    sessionId = "session-1",
    extra: SimpleStreamOptions = {},
  ) =>
    collection.completeSimple(
      model(),
      { systemPrompt: "Be brief.", messages, tools },
      { sessionId, ...extra },
    );
  return { key, mock, proxy, collection, model, turn };
}

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});
const toolResult = (message: AssistantMessage, text: string): Message => {
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call?.type === "toolCall");
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
};
const text = (message: AssistantMessage) =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

/** Upstream input without per-run ids, for comparing what CPA would send. */
function project(items: readonly unknown[]): unknown[] {
  const calls = new Map<unknown, number>();
  const callId = (id: unknown) => {
    if (!calls.has(id)) calls.set(id, calls.size);
    return calls.get(id);
  };
  return items.map((item) => {
    if (!isJson(item)) return item;
    const content = item.content;
    return {
      type: item.type ?? "message",
      role: item.role,
      text:
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part) => (isJson(part) ? part.text : undefined))
                .join("")
            : undefined,
      summary: Array.isArray(item.summary)
        ? item.summary.map((part) => (isJson(part) ? part.text : undefined))
        : undefined,
      call: item.call_id === undefined ? undefined : callId(item.call_id),
      name: item.name,
      arguments:
        typeof item.arguments === "string"
          ? JSON.stringify(JSON.parse(item.arguments))
          : undefined,
      output: item.output,
    };
  });
}

test("continues GPT turns over one WebSocket and sends CPA the same history as SSE", async (t) => {
  const runs = [];
  for (const websocket of [true, false]) {
    const f = await fixture(t, { websocket });
    const messages: Message[] = [user("use the tool")];
    const first = await f.turn(messages);
    assert.equal(first.stopReason, "toolUse");
    const call = first.content.find((block) => block.type === "toolCall");
    assert.deepEqual(call?.type === "toolCall" ? call.arguments : undefined, {
      text: "héllo 🌍",
      note: null,
    });
    messages.push(first, toolResult(first, "echoed"));
    const second = await f.turn(messages);
    assert.equal(text(second), "done: echoed ✓");
    messages.push(second, user("thanks"));
    const third = await f.turn(messages);
    assert.equal(text(third), "reply to thanks 👋");
    assert.deepEqual(
      [third.usage.input, third.usage.cacheRead, third.usage.output],
      [25, 100, 12],
    );
    runs.push({ websocket, f });
  }
  const [ws, sse] = runs;
  assert.ok(ws && sse);
  assert.deepEqual(
    ws.f.mock.requests.map((request) => [
      request.transport,
      request.connection,
      request.delta,
    ]),
    [
      ["websocket", 1, false],
      ["websocket", 1, true],
      ["websocket", 1, true],
    ],
  );
  assert.deepEqual(
    ws.f.mock.requests.map((request) => project(request.merged)),
    sse.f.mock.requests.map((request) => project(request.merged)),
  );
  assert.ok(
    sse.f.mock.requests.every((request) => request.transport === "sse"),
  );
  const [status] = ws.f.proxy.transport.status();
  assert.deepEqual(
    [
      status?.stats.fullRequests,
      status?.stats.deltaRequests,
      status?.stats.connectionsOpened,
      status?.stats.sseRequests,
    ],
    [1, 2, 1, 0],
  );
});

test("starts a fresh connection when history stops extending the last exchange", async (t) => {
  const f = await fixture(t);
  const first = await f.turn([user("first")]);
  // Rewound branch: the earlier user message changed.
  const rewound = await f.turn([user("edited")]);
  assert.equal(text(rewound), "reply to edited 👋");
  // Compaction and tree navigation close the session's connection.
  f.proxy.transport.closeSession("session-1");
  const after = await f.turn([user("edited"), rewound, user("next")]);
  assert.equal(text(after), "reply to next 👋");
  assert.equal(text(first), "reply to first 👋");
  assert.deepEqual(
    f.mock.requests.map((request) => [request.connection, request.delta]),
    [
      [1, false],
      [2, false],
      [3, false],
    ],
  );
});

test("resends the full history when CPA rejects a continuation", async (t) => {
  for (const fault of [
    { forgetContinuation: true },
    { closeAfterRequest: 1012 },
  ]) {
    const f = await fixture(t);
    const first = await f.turn([user("a")]);
    Object.assign(f.mock.faults, fault);
    const second = await f.turn([user("a"), first, user("b")]);
    assert.equal(text(second), "reply to b 👋", JSON.stringify(fault));
    const [, resent] = f.mock.requests;
    assert.deepEqual(
      f.mock.requests.map((request) => [
        request.transport,
        request.connection,
        request.delta,
      ]),
      [
        ["websocket", 1, false],
        ["websocket", 2, false],
      ],
    );
    assert.deepEqual(
      project(resent?.merged ?? []).map((item) =>
        isJson(item) ? item.text : item,
      ),
      ["Be brief.", "a", "reply to a 👋", "b"],
    );
    assert.match(
      f.proxy.transport.status()[0]?.stats.lastFallback ?? "",
      /full history/,
    );
  }
});

test("uses SSE only when nothing reached CPA", async (t) => {
  const refused = await fixture(t);
  refused.mock.faults.rejectUpgrade = 404;
  assert.equal(text(await refused.turn([user("a")])), "reply to a 👋");
  assert.deepEqual(
    refused.mock.requests.map((request) => request.transport),
    ["sse"],
  );
  const [status] = refused.proxy.transport.status();
  assert.match(status?.stats.lastFallback ?? "", /WebSocket connect failed/);
  assert.ok(status?.websocketPausedUntil);

  // CPA received the request and dropped the connection: resending could duplicate the turn.
  const dropped = await fixture(t);
  dropped.mock.faults.closeAfterRequest = 1011;
  const failed = await dropped.turn([user("a")]);
  assert.equal(failed.stopReason, "error");
  assert.equal(dropped.mock.requests.length, 0);
  assert.equal(text(await dropped.turn([user("a")])), "reply to a 👋");
  assert.deepEqual(
    dropped.mock.requests.map((request) => [
      request.transport,
      request.connection,
    ]),
    [["websocket", 2]],
  );
});

test("lets Pi retry a response dropped before response.completed", async (t) => {
  for (const [code, closed] of [
    [1000, "1000: test close"],
    [1006, "1006"],
  ] as const) {
    const f = await fixture(t);
    f.mock.faults.closeBeforeCompleted = code;
    const attempts: AssistantMessage[] = [];
    // Pi's own bounded retry loop and classifier, as used for agent turns.
    const result = await retryAssistantCall(
      async () => {
        const attempt = await f.turn([user("a")]);
        attempts.push(attempt);
        return attempt;
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      undefined,
    );
    const [dropped] = attempts;
    assert.equal(result.stopReason, "stop", dropped?.errorMessage);
    assert.equal(text(result), "reply to a 👋");
    assert.equal(dropped?.stopReason, "error");
    assert.equal(
      dropped.errorMessage,
      `WebSocket closed before the response completed (${closed})`,
    );
    // The drop came after streamed content, not before CPA answered.
    assert.equal(text(dropped), "reply to a 👋");
    // One request per Pi attempt: the extension never resent the delivered request itself.
    assert.deepEqual(
      f.mock.requests.map((request) => [request.transport, request.connection]),
      [
        ["websocket", 1],
        ["websocket", 2],
      ],
    );
  }
});

test("aborts a stalled request and recovers on a new connection", async (t) => {
  const f = await fixture(t);
  f.mock.faults.stall = true;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await f.turn([user("a")], "session-1", {
    signal: controller.signal,
  });
  assert.equal(aborted.stopReason, "aborted");
  assert.equal(text(await f.turn([user("a")])), "reply to a 👋");
  assert.deepEqual(
    f.mock.requests.map((request) => [request.connection, request.delta]),
    [[2, false]],
  );
});

test("keeps sessions apart and sends concurrent same-session requests over SSE", async (t) => {
  const f = await fixture(t);
  const [a1, b1] = await Promise.all([
    f.turn([user("a")], "session-a"),
    f.turn([user("b")], "session-b"),
  ]);
  const [a2, b2] = await Promise.all([
    f.turn([user("a"), a1, user("a2")], "session-a"),
    f.turn([user("b"), b1, user("b2")], "session-b"),
  ]);
  assert.deepEqual([text(a2), text(b2)], ["reply to a2 👋", "reply to b2 👋"]);
  const connectionOf = (word: string) =>
    f.mock.requests
      .filter((request) => lastUserText(request.merged).startsWith(word))
      .map((request) => [request.connection, request.delta]);
  const [[firstA], [firstB]] = [connectionOf("a"), connectionOf("b")];
  assert.notEqual(firstA?.[0], firstB?.[0]);
  assert.deepEqual(connectionOf("a"), [
    [firstA?.[0], false],
    [firstA?.[0], true],
  ]);
  assert.deepEqual(connectionOf("b"), [
    [firstB?.[0], false],
    [firstB?.[0], true],
  ]);

  const [one, two] = await Promise.all([
    f.turn([user("c")], "session-c"),
    f.turn([user("d")], "session-c"),
  ]);
  assert.deepEqual([text(one), text(two)], ["reply to c 👋", "reply to d 👋"]);
  assert.deepEqual(
    f.mock.requests
      .slice(-2)
      .map((request) => request.transport)
      .sort(),
    ["sse", "websocket"],
  );
});

test("sends a model with another baseUrl to that endpoint over HTTP", async (t) => {
  const f = await fixture(t);
  const other = await startMockCpa({ apiKey: f.key, reply: scripted });
  t.after(() => other.close());
  const elsewhere = { ...f.model(), baseUrl: `${other.root}/v1` };
  const result = await f.collection.completeSimple(
    elsewhere,
    { messages: [user("a")] },
    { sessionId: "session-1" },
  );
  assert.equal(text(result), "reply to a 👋");
  assert.deepEqual(
    other.requests.map((request) => request.transport),
    ["sse"],
  );
  assert.equal(f.mock.requests.length, 0);
});

test("sends Claude to /v1/messages with adaptive thinking, images and usage", async (t) => {
  const f = await fixture(t);
  const result = await f.collection.completeSimple(
    f.model("claude-opus-5-5"),
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "héllo 🌍" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { reasoning: "high", sessionId: "session-1" },
  );
  assert.equal(text(result), "reply to héllo 🌍 👋");
  const [request] = f.mock.requests;
  assert.equal(request?.path, "/v1/messages");
  const body = request?.body ?? {};
  assert.ok(isJson(body.thinking) && body.thinking.type === "adaptive");
  assert.match(JSON.stringify(body.messages), /"type":"image"/);
  assert.deepEqual(
    [result.usage.input, result.usage.cacheRead, result.usage.output],
    [25, 100, 12],
  );
});
