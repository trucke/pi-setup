import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createMcpCaller,
  HostedError,
  MCP_URLS,
  providerFailure,
  type CallHosted,
  type FailureKind,
} from "./mcp.ts";
import { searchHosted } from "./search.ts";

// AbortSignal.timeout is unref'd: keep the loop alive while deadlines run.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

type Rpc = { id?: number; method: string; params?: { arguments?: unknown } };

function rpcResult(body: Rpc, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

/** Answers the MCP handshake; `onToolCall` owns the tools/call response. */
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

/** A body that never ends, recording whether the caller released it. */
function openStream(chunk = "", state = { cancelled: false }) {
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
const SSE = { headers: { "Content-Type": "text/event-stream" } };

const invoke = (call: CallHosted, signal = new AbortController().signal) =>
  call({ provider: "exa", tool: "web_search_exa", args: {}, signal });
const hasKind = (kind: FailureKind) => (error: unknown) =>
  error instanceof HostedError && error.kind === kind;

test("anonymous SSE search completes without EOF, sanitized and without credentials", async () => {
  const stream = { cancelled: false };
  const mock = mcpFetch((body) => {
    const data = JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: textResult("# Result\nhttps://example.com\u001b[31m"),
    });
    return new Response(
      openStream(`event: message\ndata: ${data}\n\n`, stream).body,
      SSE,
    );
  });
  const result = await searchHosted(
    createMcpCaller({ fetch: mock.fetch, timeoutMs: 200 }),
    { query: "A source", limit: 3 },
  );
  assert.deepEqual(result, {
    provider: "exa",
    text: "# Result\nhttps://example.com",
  });
  assert.equal(stream.cancelled, true);
  for (const { url, init } of mock.requests) {
    assert.equal(url, MCP_URLS.exa);
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-api-key"), null);
  }
});

test("an Exa HTTP 429 falls back to Firecrawl with attribution and the same filters", async () => {
  const exa = mcpFetch(
    () =>
      new Response("Rate limit reached, add API key for higher limits", {
        status: 429,
      }),
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
  const sent = (mock: typeof exa) =>
    mock.requests.find(({ body }) => body.method === "tools/call");
  // Exa only serves the advanced tool when the endpoint enables it.
  assert.match(sent(exa)?.url ?? "", /tools=.*web_search_advanced_exa/);
  assert.deepEqual(sent(firecrawl)?.body.params?.arguments, {
    query: "release",
    limit: 5,
    includeDomains: ["example.com"],
    tbs: "qdr:w",
    highlights: true,
  });
});

test("only transient, rate-limit and unavailable failures reach a second provider", async () => {
  const policy: Array<[FailureKind, boolean]> = [
    ["transient", true],
    ["rate-limit", true],
    ["unavailable", true],
    ["auth", false],
    ["billing", false],
    ["validation", false],
    ["unsafe", false],
    ["cancelled", false],
    ["protocol", false],
  ];
  for (const [kind, fallsBack] of policy) {
    const providers: string[] = [];
    const attempt = searchHosted(
      async ({ provider }) => {
        providers.push(provider);
        if (provider === "exa") throw new HostedError(kind, "fixture failure");
        return "results";
      },
      { query: "private query" },
    );
    if (fallsBack)
      assert.match((await attempt).fallbackReason ?? "", new RegExp(kind));
    else await assert.rejects(attempt, hasKind(kind));
    assert.deepEqual(providers, fallsBack ? ["exa", "firecrawl"] : ["exa"]);
  }
});

test("explicit providers, empty results and cancellation never reach a second provider", async () => {
  const providers: string[] = [];
  const failing: CallHosted = async ({ provider }) => {
    providers.push(provider);
    throw new HostedError("transient", "network");
  };
  await assert.rejects(
    searchHosted(failing, { query: "q", provider: "exa" }),
    /network/,
  );
  const empty = await searchHosted(
    async ({ provider }) => {
      providers.push(provider);
      return "";
    },
    { query: "q" },
  );
  assert.equal(empty.provider, "exa");
  const controller = new AbortController();
  await assert.rejects(
    searchHosted(
      async (call) => {
        controller.abort();
        return failing(call);
      },
      { query: "q" },
      controller.signal,
    ),
    /abort/i,
  );
  assert.deepEqual(providers, ["exa", "exa", "exa"]);
});

test("classification lets billing and auth win over retryable signals and leaves unknowns terminal", () => {
  for (const [text, status, expected] of [
    ["Rate limit reached, add API key for higher limits", 429, "rate-limit"],
    ["Request failed with status code 429", undefined, "rate-limit"],
    ["Rate limit reached, upgrade your plan", 401, "auth"],
    ["Insufficient credit balance", 429, "billing"],
    ['{"statusCode":402,"error":"Request rejected"}', undefined, "billing"],
    ["Invalid API key", 503, "auth"],
    ["unsafe URL", 500, "unsafe"],
    ["Page not found", undefined, "unavailable"],
    ["fetch failed", undefined, "transient"],
    ["Unknown tool", undefined, "protocol"],
  ] as const)
    assert.equal(providerFailure(text, status).kind, expected, text);
});

test("MCP tool errors and Firecrawl in-band JSON failures are classified, not returned as results", async () => {
  for (const [result, kind] of [
    [textResult("Invalid API key", true), "auth"],
    [textResult('{"success":false,"error":"Insufficient credits"}'), "billing"],
  ] as const) {
    const mock = mcpFetch((body) => rpcResult(body, result));
    await assert.rejects(
      invoke(createMcpCaller({ fetch: mock.fetch })),
      hasKind(kind),
    );
  }
});

test("malformed SSE is a protocol failure, not a timeout fallback", async () => {
  const mock = mcpFetch(
    () => new Response("event: message\ndata: {invalid}\n\n", SSE),
  );
  await assert.rejects(
    searchHosted(createMcpCaller({ fetch: mock.fetch, timeoutMs: 20 }), {
      query: "q",
    }),
    hasKind("protocol"),
  );
  assert.ok(mock.requests.every(({ url }) => url === MCP_URLS.exa));
});

test("stalled auth, billing and redirect bodies stay terminal instead of timing out into fallback", async () => {
  for (const [status, kind] of [
    [401, "auth"],
    [402, "billing"],
    [302, "protocol"],
  ] as const) {
    const urls: string[] = [];
    const open = openStream();
    const call = createMcpCaller({
      timeoutMs: 20,
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(open.body, {
          status,
          headers: { Location: "https://elsewhere.example" },
        });
      },
    });
    await assert.rejects(
      searchHosted(call, { query: "private query" }),
      hasKind(kind),
    );
    assert.deepEqual(urls, [MCP_URLS.exa]);
    assert.equal(open.state.cancelled, true);
  }
});

test("provider responses are bounded in time and size, and cancellation reaches the transport", async () => {
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
  await assert.rejects(
    invoke(
      createMcpCaller({
        fetch: async (_url, init) => {
          transportSignal = init?.signal;
          queueMicrotask(() => controller.abort());
          return new Response(openStream().body);
        },
      }),
      controller.signal,
    ),
    hasKind("cancelled"),
  );
  assert.equal(transportSignal?.aborted, true);
});
