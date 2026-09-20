import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEVELOPER_SEARCH_URL,
  developerSearchDetails,
  developerSearchResultText,
  registerDeveloperSearchTool,
  type DeveloperSearchToolDependencies,
} from "./developer.ts";

// AbortSignal.timeout is unref'd: keep the loop alive while deadlines run.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

interface RegisteredTool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ text: string }>;
    details: { resultCount: number; auth: string };
  }>;
}

function developerTool(
  fetchMock: typeof fetch,
  dependencies: Partial<DeveloperSearchToolDependencies> = {},
) {
  let tool: RegisteredTool | undefined;
  registerDeveloperSearchTool(
    {
      registerTool: (value: RegisteredTool) => {
        tool = value;
      },
    } as unknown as ExtensionAPI,
    {
      getApiKey: () => undefined,
      ...dependencies,
      transport: { fetch: fetchMock, ...dependencies.transport },
    },
  );
  assert.ok(tool);
  return tool;
}

const okResponse = () =>
  Response.json({
    results: [
      {
        id: "issue:vercel/next.js#1",
        type: "issue",
        url: "https://github.com/vercel/next.js/issues/1",
        title: "Hydration mismatch",
        passages: [{ text: "A **relevant** passage" }],
      },
    ],
  });

/** Never responds; rejects like fetch when its signal aborts. */
const stalledFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted", "AbortError")),
    ),
  );

test("searches keyless by default and sends a configured key only as a Bearer header", async () => {
  for (const apiKey of [undefined, "fc-key"]) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const tool = developerTool(
      async (url, init) => {
        requests.push({ url: String(url), init });
        return okResponse();
      },
      { getApiKey: () => apiKey },
    );
    const result = await tool.execute("call", {
      query: "hydration mismatch",
      types: ["issue"],
    });

    assert.deepEqual(
      requests.map(({ url }) => url),
      [DEVELOPER_SEARCH_URL],
    );
    const { init } = requests[0];
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      apiKey ? "Bearer fc-key" : null,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: "hydration mismatch",
      k: 10,
      types: ["issue"],
    });
    assert.equal(result.details.auth, apiKey ? "account" : "anonymous");
    assert.equal(result.details.resultCount, 1);
    assert.match(
      result.content[0].text,
      /1\. \[issue\] Hydration mismatch\n   URL: https:\/\/github.com\/vercel\/next.js\/issues\/1\n[^]*A \*\*relevant\*\* passage/,
    );
  }
});

test("accounts only for dispatched attempts, not validation errors or pre-cancellation", async () => {
  const dispatched: string[] = [];
  let requests = 0;
  const tool = developerTool(
    async () => {
      requests++;
      return okResponse();
    },
    { onDispatch: (id, auth) => dispatched.push(`${id}:${auth}`) },
  );
  await assert.rejects(
    tool.execute("invalid", { query: "q", types: ["doc"], repos: ["a/b"] }),
    /cannot match/,
  );
  await assert.rejects(
    tool.execute("cancelled", { query: "q" }, AbortSignal.abort()),
    /cancelled/,
  );
  assert.equal(requests, 0);
  assert.deepEqual(dispatched, []);
  await tool.execute("sent", { query: "q" });
  assert.deepEqual(dispatched, ["sent:anonymous"]);
});

test("HTTP failures name the status and never echo the configured key", async () => {
  const tool = developerTool(
    async () =>
      new Response("rate limited for fc-key\u001b[31m", { status: 429 }),
    { getApiKey: () => "fc-key" },
  );
  await assert.rejects(tool.execute("call", { query: "q" }), (error: Error) => {
    assert.match(error.message, /HTTP 429\): rate limited for \[redacted\]\./);
    assert.match(error.message, /Retry developer-search/);
    return true;
  });
});

test("stalled requests end by timeout or cancellation, reported distinctly", async () => {
  await assert.rejects(
    developerTool(stalledFetch, { transport: { timeoutMs: 25 } }).execute(
      "timeout",
      { query: "q" },
    ),
    /timed out after 0\.025 seconds/,
  );
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const pending = developerTool((url, init) => {
    requestSignal = init?.signal;
    return stalledFetch(url, init);
  }).execute("cancelled", { query: "q" }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /Firecrawl developer search cancelled/);
  assert.equal(requestSignal?.aborted, true);
});

test("normalization sanitizes remote strings, keeps passage Markdown and drops unusable results", () => {
  const details = developerSearchDetails({
    results: [
      {
        id: "res_\u001b[31m1",
        type: "doc",
        url: "https://docs.example.com/\u001b[2Jpage",
        // Docs often arrive without a title: fall back to the URL.
        title: null,
        passages: [
          { text: "# Heading\n\n`code` and **bold** survive" },
          { text: "  " },
          { text: "x".repeat(5_000) },
        ],
      },
      { id: "res_2", type: "issue", title: "No URL is dropped" },
    ],
    coverage: { doc: "ok", issue: "degraded\u001b[31m" },
    repos: [{ repo: "owner/name", indexed: false }],
  });
  assert.deepEqual(details.results, [
    {
      id: "res_1",
      type: "doc",
      title: "https://docs.example.com/page",
      url: "https://docs.example.com/page",
      passages: ["# Heading\n\n`code` and **bold** survive", "x".repeat(2_000)],
    },
  ]);
  const text = developerSearchResultText(details);
  assert.match(text, /^Coverage: doc ok · issue degraded · /);
  assert.match(text, /   `code` and \*\*bold\*\* survive/);
  assert.match(text, /Not indexed: repo owner\/name/);
});

test("live response shapes infer types from IDs, map canonical repositories and report absent coverage", () => {
  const details = developerSearchDetails({
    results: [
      {
        id: "pull_request:react/react#34660",
        url: "https://github.com/react/react/issues/34660",
        passages: [{ text: "Relevant passage" }],
      },
      { id: "unexpected:foo", url: "https://example.com" },
    ],
    repos: [
      { repo: "facebook/react", canonicalRepo: "react/react", indexed: true },
    ],
  });
  assert.deepEqual(
    details.results.map(({ type }) => type),
    ["pull_request", "unknown"],
  );
  assert.equal(details.coverage, undefined);
  const text = developerSearchResultText(details);
  assert.match(text, /Coverage: not reported/);
  assert.match(text, /facebook\/react → react\/react \(indexed\)/);
});
