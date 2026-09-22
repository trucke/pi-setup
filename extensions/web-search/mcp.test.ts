import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createMcpCaller,
  HostedError,
  MCP_URLS,
  type CallHosted,
  type FailureKind,
} from "./mcp.ts";
import { searchHosted } from "./search.ts";

// AbortSignal.timeout is unref'd; keep stalled transport fixtures alive.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
type Rpc = { id?: number; method: string; params?: { arguments?: unknown } };
const SSE = { headers: { "Content-Type": "text/event-stream" } };
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});
const rpcResult = (body: Rpc, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id: body.id, result });

function mcpFetch(onToolCall: (body: Rpc) => Response) {
  const requests: Array<{ url: string; init: RequestInit; body: Rpc }> = [];
  const fetchMock: typeof fetch = async (url, init) => {
    assert.ok(init);
    const body = JSON.parse(String(init.body)) as Rpc;
    requests.push({ url: String(url), init, body });
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "tools/call") return onToolCall(body);
    return rpcResult(body, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
  };
  return { requests, fetch: fetchMock };
}

function openStream(chunk = "") {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}
const invoke = (call: CallHosted, signal = new AbortController().signal) =>
  call({ provider: "exa", tool: "web_search_exa", args: {}, signal });
const hasKind = (kind: FailureKind) => (error: unknown) =>
  error instanceof HostedError && error.kind === kind;

test("SSE results complete without EOF, strip terminal escapes and send no credentials", async () => {
  let stream: ReturnType<typeof openStream> | undefined;
  const mock = mcpFetch((body) => {
    const data = JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: textResult("result\u001b[31m"),
    });
    stream = openStream(`event: message\ndata: ${data}\n\n`);
    return new Response(stream.body, SSE);
  });
  assert.equal(
    await invoke(createMcpCaller({ fetch: mock.fetch, timeoutMs: 200 })),
    "result",
  );
  assert.equal(stream?.state.cancelled, true);
  for (const { url, init } of mock.requests) {
    assert.equal(url, MCP_URLS.exa);
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), null);
    assert.equal(new Headers(init.headers).get("x-api-key"), null);
  }
});

test("eligible failures fall back once, preserving filters and provider attribution", async () => {
  const exa = mcpFetch(
    () => new Response("Rate limit reached", { status: 429 }),
  );
  const firecrawl = mcpFetch((body) => rpcResult(body, textResult("results")));
  const result = await searchHosted(
    createMcpCaller({
      fetch: (url, init) =>
        (String(url).startsWith(MCP_URLS.exa) ? exa : firecrawl).fetch(
          url,
          init,
        ),
    }),
    { query: "release", includeDomains: ["example.com"], recency: "week" },
  );
  assert.equal(result.provider, "firecrawl");
  assert.match(result.fallbackReason ?? "", /rate-limit/);
  assert.match(
    exa.requests.find(({ body }) => body.method === "tools/call")!.url,
    /tools=.*web_search_advanced_exa/,
  );
  assert.deepEqual(
    firecrawl.requests.find(({ body }) => body.method === "tools/call")!.body
      .params?.arguments,
    {
      query: "release",
      limit: 5,
      includeDomains: ["example.com"],
      tbs: "qdr:w",
      highlights: true,
    },
  );
  for (const kind of ["transient", "unavailable"] as const) {
    const providers: string[] = [];
    await searchHosted(
      async ({ provider }) => {
        providers.push(provider);
        if (provider === "exa") throw new HostedError(kind, "failure");
        return "results";
      },
      { query: "q" },
    );
    assert.deepEqual(providers, ["exa", "firecrawl"]);
  }
});

test("terminal HTTP, tool and protocol errors never disclose the query to a fallback", async () => {
  const cases: Array<[FailureKind, (body: Rpc) => Response]> = [
    ["auth", () => new Response(openStream().body, { status: 401 })],
    ["billing", () => new Response(openStream().body, { status: 402 })],
    [
      "protocol",
      () =>
        new Response(openStream().body, {
          status: 302,
          headers: { Location: "https://elsewhere.example" },
        }),
    ],
    [
      "billing",
      () => new Response("Insufficient credit balance", { status: 429 }),
    ],
    ["validation", () => new Response("invalid parameters", { status: 400 })],
    ["unsafe", () => new Response("unsafe URL", { status: 500 })],
    ["auth", (body) => rpcResult(body, textResult("Invalid API key", true))],
    [
      "billing",
      (body) =>
        rpcResult(
          body,
          textResult('{"success":false,"error":"Insufficient credits"}'),
        ),
    ],
    [
      "protocol",
      () => new Response("event: message\ndata: {invalid}\n\n", SSE),
    ],
  ];
  for (const [kind, response] of cases) {
    const mock = mcpFetch(response);
    await assert.rejects(
      searchHosted(createMcpCaller({ fetch: mock.fetch, timeoutMs: 50 }), {
        query: "private query",
      }),
      hasKind(kind),
    );
    assert.ok(mock.requests.every(({ url }) => url === MCP_URLS.exa));
  }
});

test("explicit providers and empty results do not trigger another provider", async () => {
  let calls = 0;
  await assert.rejects(
    searchHosted(
      async () => {
        calls++;
        throw new HostedError("transient", "network");
      },
      { query: "q", provider: "exa" },
    ),
  );
  await searchHosted(
    async () => {
      calls++;
      return "";
    },
    { query: "q" },
  );
  assert.equal(calls, 2);
});

test("provider bodies are bounded and cancellation reaches the transport", async () => {
  const stalled = openStream("partial");
  await assert.rejects(
    invoke(
      createMcpCaller({
        timeoutMs: 20,
        fetch: async () => new Response(stalled.body, SSE),
      }),
    ),
    /timed out/,
  );
  assert.equal(stalled.state.cancelled, true);
  await assert.rejects(
    invoke(
      createMcpCaller({
        fetch: async () =>
          new Response("x".repeat(4 * 1024 * 1024 + 1), {
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ),
    /exceeds/,
  );
  const controller = new AbortController();
  let transportSignal: AbortSignal | null | undefined;
  let requests = 0;
  await assert.rejects(
    searchHosted(
      createMcpCaller({
        fetch: async (_url, init) => {
          requests++;
          transportSignal = init?.signal;
          queueMicrotask(() => controller.abort());
          return new Response(openStream().body);
        },
      }),
      { query: "q" },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(transportSignal?.aborted, true);
  assert.equal(requests, 1);
});
