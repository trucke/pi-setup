import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPER_SEARCH_URL,
  buildDeveloperSearchRequest,
  createOptionalFirecrawlKeyProvider,
  developerSearchDetails,
  developerSearchResultText,
  developerSearchView,
  registerDeveloperSearchTool,
  type DeveloperSearchToolDependencies,
} from "./developer.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
  ) => Promise<unknown>;
}

function registerTool(dependencies: DeveloperSearchToolDependencies) {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  registerDeveloperSearchTool(pi, dependencies);
  const tool = tools.find((entry) => entry.name === "developer-search");
  assert.ok(tool);
  return tool;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_RESPONSE = {
  success: true,
  results: [
    {
      id: "res_1",
      type: "issue",
      url: "https://github.com/vercel/next.js/issues/1",
      title: "Hydration mismatch",
      passages: [{ text: "A **relevant** passage" }],
    },
  ],
  coverage: {
    doc: "ok",
    issue: "ok",
    pull_request: "ok",
    readme: "ok",
  },
  reranked: true,
};

test("maps the model-facing limit to k and omits absent filters", () => {
  assert.deepEqual(buildDeveloperSearchRequest({ query: "q", limit: 10 }), {
    query: "q",
    k: 10,
  });
  assert.deepEqual(
    buildDeveloperSearchRequest({
      query: "q",
      limit: 99,
      types: ["doc", "issue", "pull_request"],
      repos: ["vercel/next.js"],
      sources: ["src_nextjs"],
      passages: 3,
    }),
    {
      query: "q",
      k: 20,
      types: ["doc", "issue", "pull_request"],
      repos: ["vercel/next.js"],
      sources: ["src_nextjs"],
      passages: 3,
    },
  );
});

test("rejects filters that cannot match the requested types", () => {
  assert.throws(
    () =>
      buildDeveloperSearchRequest({
        query: "q",
        limit: 10,
        types: ["doc"],
        repos: ["owner/repo"],
      }),
    /repos cannot match.*add issue, pull_request, or readme, or drop repos/,
  );
  assert.throws(
    () =>
      buildDeveloperSearchRequest({
        query: "q",
        limit: 10,
        types: ["issue"],
        sources: ["library-docs"],
      }),
    /sources cannot match.*add doc or drop sources/,
  );

  assert.doesNotThrow(() =>
    buildDeveloperSearchRequest({
      query: "q",
      limit: 10,
      types: ["doc", "issue"],
      repos: ["owner/repo"],
      sources: ["library-docs"],
    }),
  );
});

test("normalizes and sanitizes responses, preserving passage Markdown", () => {
  const details = developerSearchDetails({
    results: [
      {
        id: "res_\u001b[31m1",
        type: "doc",
        url: "https://docs.example.com/\u001b[2Jpage",
        // Docs often arrive without a title: fall back to the URL.
        title: null,
        passages: [
          { text: "# Heading\n\n`code` and **bold** survive" },
          { text: "  " },
          { text: "x".repeat(5_000) },
        ],
      },
      { id: "res_2", type: "issue", title: "No URL is dropped" },
    ],
    coverage: {
      doc: "ok",
      issue: "degraded\u001b[31m",
      pull_request: "unavailable",
      readme: "skipped",
    },
    reranked: true,
    repos: [
      { repo: "owner/name", indexed: false, types: { issue: true } },
      { repo: "" },
    ],
    sources: [{ source: "src_docs", indexed: true }],
  });

  assert.equal(details.backend, "firecrawl");
  assert.equal(details.results.length, 1);
  assert.deepEqual(
    { ...details.results[0], passages: details.results[0].passages.length },
    {
      id: "res_1",
      type: "doc",
      title: "https://docs.example.com/page",
      url: "https://docs.example.com/page",
      passages: 2,
    },
  );
  assert.equal(
    details.results[0].passages[0],
    "# Heading\n\n`code` and **bold** survive",
  );
  assert.equal(details.results[0].passages[1].length, 2_000);
  assert.deepEqual(details.coverage, {
    doc: "ok",
    issue: "degraded",
    pull_request: "unavailable",
    readme: "skipped",
  });
  assert.equal(details.reranked, true);
  assert.deepEqual(details.repos, [
    {
      repo: "owner/name",
      indexed: false,
      types: { issue: true, pullRequest: false, readme: false },
    },
  ]);
  assert.deepEqual(details.sources, [{ source: "src_docs", indexed: true }]);

  const text = developerSearchResultText(details);
  assert.match(text, /^Coverage: doc ok · issue degraded/);
  assert.match(text, /1\. \[doc\] https:\/\/docs\.example\.com\/page/);
  assert.match(text, /   URL: https:\/\/docs\.example\.com\/page/);
  assert.match(text, /   ID: res_1/);
  assert.match(text, /   `code` and \*\*bold\*\* survive/);
  assert.match(text, /Not indexed: repo owner\/name/);
});

test("bounds persisted results and passages to the tool schema", () => {
  const details = developerSearchDetails({
    results: Array.from({ length: 25 }, (_, index) => ({
      id: `doc:${index}`,
      type: "doc",
      url: `https://example.com/${index}`,
      passages: Array.from({ length: 7 }, () => ({ text: "x".repeat(3_000) })),
    })),
  });

  assert.equal(details.results.length, 20);
  assert.equal(details.results[0].passages.length, 5);
  assert.equal(details.results[0].passages[0].length, 2_000);
});

test("reports missing results with the coverage summary", () => {
  const text = developerSearchResultText(developerSearchDetails({}));
  assert.match(text, /Coverage: doc unknown/);
  assert.match(text, /No developer search results returned\./);
});

test("re-validates restored session details before rendering", () => {
  const view = developerSearchView({
    results: [
      {
        id: 42,
        type: "doc",
        url: "https://example.com",
        passages: ["**restored**\u001b[31m passage"],
      },
      "not a record",
    ],
    coverage: { doc: "ok" },
    repos: "not an array",
  });
  assert.equal(view.results.length, 1);
  assert.deepEqual(view.results[0], {
    id: "",
    type: "doc",
    title: "https://example.com",
    url: "https://example.com",
    passages: ["**restored** passage"],
  });
  assert.equal(view.coverage.doc, "ok");
  assert.equal(view.coverage.issue, "unknown");
  assert.equal(view.repos, undefined);

  assert.deepEqual(developerSearchView(undefined).results, []);
});

test("sends keyless requests without an Authorization header", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const tool = registerTool({
    getApiKey: () => undefined,
    transport: {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse(OK_RESPONSE);
      }) as typeof fetch,
    },
  });

  const result = (await tool.execute(
    "keyless",
    { query: "hydration mismatch", types: ["issue"] },
    undefined,
    undefined,
  )) as {
    content: Array<{ type: string; text: string }>;
    details: { results: Array<{ url: string }> };
  };

  assert.deepEqual(
    requests.map((request) => request.url),
    [DEVELOPER_SEARCH_URL],
  );
  const { init } = requests[0];
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(!("Authorization" in headers));
  assert.deepEqual(JSON.parse(String(init.body)), {
    query: "hydration mismatch",
    k: 10,
    types: ["issue"],
  });

  assert.deepEqual(
    result.details.results.map((item) => item.url),
    ["https://github.com/vercel/next.js/issues/1"],
  );
  assert.match(result.content[0].text, /1\. \[issue\] Hydration mismatch/);
  assert.match(result.content[0].text, /A \*\*relevant\*\* passage/);
});

test("sends the configured key as a Bearer Authorization header", async () => {
  let headers: Record<string, string> = {};
  const tool = registerTool({
    getApiKey: () => "fc-key",
    transport: {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return jsonResponse(OK_RESPONSE);
      }) as typeof fetch,
    },
  });

  await tool.execute("keyed", { query: "q" }, undefined, undefined);
  assert.equal(headers.Authorization, "Bearer fc-key");
});

test("memoizes the optional key lookup", () => {
  let lookups = 0;
  const env: NodeJS.ProcessEnv = {};
  Object.defineProperty(env, "FIRECRAWL_API_KEY", {
    get: () => {
      lookups += 1;
      return "fc-key";
    },
  });
  const getKey = createOptionalFirecrawlKeyProvider({
    env,
    envPath: "/not-used",
  });
  assert.equal(getKey(), "fc-key");
  assert.equal(getKey(), "fc-key");
  assert.equal(lookups, 1);

  const missing = createOptionalFirecrawlKeyProvider({
    env: {},
    envPath: "/not-used",
  });
  assert.equal(missing(), undefined);
});

test("names the status and retry on HTTP failures", async () => {
  const tool = registerTool({
    getApiKey: () => undefined,
    transport: {
      fetch: (async () =>
        new Response("rate limited", { status: 429 })) as typeof fetch,
    },
  });

  await assert.rejects(
    tool.execute("http-error", { query: "q" }, undefined, undefined),
    /Firecrawl developer search failed \(HTTP 429\): rate limited\. Retry developer-search/,
  );
});

test("bounds stalled requests with the operation timeout", async () => {
  const tool = registerTool({
    getApiKey: () => undefined,
    transport: {
      timeoutMs: 25,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
              }),
            ),
          );
        })) as typeof fetch,
    },
  });

  await assert.rejects(
    tool.execute("timeout", { query: "q" }, undefined, undefined),
    /Firecrawl developer search timed out after 0\.025 seconds\./,
  );
});

test("reports tool cancellation distinctly from failures", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const tool = registerTool({
    getApiKey: () => undefined,
    transport: {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
              }),
            ),
          );
          queueMicrotask(() => controller.abort());
        })) as typeof fetch,
    },
  });

  await assert.rejects(
    tool.execute("cancelled", { query: "q" }, controller.signal, undefined),
    /Firecrawl developer search cancelled/,
  );
  assert.equal(requestSignal?.aborted, true);
});
