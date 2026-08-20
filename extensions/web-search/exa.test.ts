import assert from "node:assert/strict";
import test from "node:test";
import {
  EXA_CONTENTS_URL,
  EXA_SEARCH_URL,
  buildExaContentsRequest,
  buildExaSearchRequest,
  createExaKeyProvider,
  exaFetch,
  exaFetchResult,
  exaSearch,
  exaSearchDetails,
} from "./exa.ts";

const RETRY_HINT = 'Retry with backend: "firecrawl".';

function keyProvider(apiKey = "exa-key") {
  return async () => apiKey;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("builds a cheap search request with query highlights only", () => {
  const now = () => Date.parse("2026-08-20T12:00:00.000Z");
  const request = buildExaSearchRequest({
    query: "react vs vue performance comparison",
    limit: 5,
    includeDomains: ["example.com"],
    recency: "week",
    now,
  });

  assert.deepEqual(request, {
    query: "react vs vue performance comparison",
    type: "auto",
    numResults: 5,
    includeDomains: ["example.com"],
    startPublishedDate: "2026-08-13T12:00:00.000Z",
    contents: {
      highlights: { query: "react vs vue performance comparison" },
    },
  });

  const minimal = buildExaSearchRequest({ query: "q", limit: 3, now });
  assert.deepEqual(Object.keys(minimal), [
    "query",
    "type",
    "numResults",
    "contents",
  ]);
});

test("builds a contents request for one arbitrary known URL", () => {
  assert.deepEqual(buildExaContentsRequest({ url: "https://example.com/a" }), {
    ids: ["https://example.com/a"],
    contents: {
      text: true,
      livecrawl: "fallback",
    },
  });
  assert.deepEqual(
    buildExaContentsRequest({
      url: "https://example.com/a",
      maxCharacters: 2_000,
      fresh: true,
    }),
    {
      ids: ["https://example.com/a"],
      contents: {
        text: { maxCharacters: 2000 },
        livecrawl: "preferred",
      },
    },
  );
});

test("normalizes and sanitizes search responses into bounded details", () => {
  const details = exaSearchDetails({
    results: [
      {
        title: "Result\u001b[31m one",
        url: "https://example.com/one",
        publishedDate: "2026-08-01T00:00:00.000Z",
        highlights: ["First highlight", "Second\u0007 highlight"],
        text: "ignored because highlights exist",
      },
      { title: "No URL is dropped" },
      { url: "https://example.com/untitled", text: "x".repeat(5_000) },
    ],
  });

  assert.equal(details.backend, "exa");
  assert.equal(details.results.length, 2);
  assert.deepEqual(details.results[0], {
    title: "Result one",
    url: "https://example.com/one",
    publishedDate: "2026-08-01T00:00:00.000Z",
    snippet: "First highlight\nSecond highlight",
  });
  assert.equal(details.results[1].title, "https://example.com/untitled");
  assert.equal(details.results[1].snippet.length, 1_500);
});

test("formats contents responses and keeps page text out of details", () => {
  const { details, output } = exaFetchResult(
    {
      results: [
        {
          title: "Page\u001b[2J title",
          url: "https://example.com/page",
          publishedDate: "2026-08-01T00:00:00.000Z",
          author: "Author",
          text: "Body\u001b]0;owned\u0007 content",
        },
      ],
      statuses: [
        {
          id: "https://example.com/broken",
          status: "error",
          error: { tag: "CRAWL_NOT_FOUND" },
        },
      ],
    },
    "https://example.com/page",
    RETRY_HINT,
  );

  assert.deepEqual(details, {
    backend: "exa",
    pages: [
      {
        title: "Page title",
        url: "https://example.com/page",
        publishedDate: "2026-08-01T00:00:00.000Z",
        author: "Author",
        characters: 12,
      },
    ],
    errors: [{ url: "https://example.com/broken", reason: "CRAWL_NOT_FOUND" }],
  });
  assert.match(output, /^# Page title\nURL: https:\/\/example\.com\/page/);
  assert.match(output, /Body content/);
  assert.match(
    output,
    /Error fetching https:\/\/example\.com\/broken: CRAWL_NOT_FOUND/,
  );
  assert.ok(
    !("text" in (details.pages[0] as unknown as Record<string, unknown>)),
  );
});

test("reports empty contents responses as errors naming the firecrawl retry", () => {
  assert.throws(
    () =>
      exaFetchResult(
        {
          results: [],
          statuses: [
            {
              id: "https://example.com/a",
              status: "error",
              error: { tag: "CRAWL_TIMEOUT" },
            },
          ],
        },
        "https://example.com/a",
        RETRY_HINT,
      ),
    /CRAWL_TIMEOUT.*Retry with backend: "firecrawl"\./,
  );
  assert.throws(
    () => exaFetchResult({}, "https://example.com/a", RETRY_HINT),
    /no content for https:\/\/example\.com\/a\. Retry with backend: "firecrawl"\./,
  );
});

test("sends authenticated JSON requests to the Exa endpoints", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const transport = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        results: [{ title: "One", url: "https://example.com/one" }],
      });
    }) as typeof fetch,
  };

  const details = await exaSearch(
    keyProvider(),
    { query: "q", limit: 5 },
    RETRY_HINT,
    undefined,
    transport,
  );
  assert.equal(details.results[0].url, "https://example.com/one");

  await exaFetch(
    keyProvider(),
    { url: "https://example.com/one" },
    RETRY_HINT,
    undefined,
    transport,
  );

  assert.deepEqual(
    requests.map((request) => request.url),
    [EXA_SEARCH_URL, EXA_CONTENTS_URL],
  );
  for (const { init } of requests) {
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "exa-key");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(typeof init.body, "string");
  }
  const searchBody = JSON.parse(String(requests[0].init.body));
  assert.equal(searchBody.type, "auto");
  const contentsBody = JSON.parse(String(requests[1].init.body));
  assert.deepEqual(contentsBody.ids, ["https://example.com/one"]);
  assert.deepEqual(contentsBody.contents, {
    text: true,
    livecrawl: "fallback",
  });
});

test("names the status and explicit retry on HTTP failures", async () => {
  const transport = {
    fetch: (async () =>
      new Response("invalid api key", { status: 401 })) as typeof fetch,
  };

  await assert.rejects(
    exaSearch(
      keyProvider(),
      { query: "q", limit: 5 },
      RETRY_HINT,
      undefined,
      transport,
    ),
    /Exa search failed \(HTTP 401\): invalid api key\. Retry with backend: "firecrawl"\./,
  );
});

test("bounds stalled requests with the operation timeout", async () => {
  let requestSignal: AbortSignal | undefined;
  const transport = {
    timeoutMs: 25,
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
      })) as typeof fetch,
  };

  await assert.rejects(
    exaSearch(
      keyProvider(),
      { query: "q", limit: 5 },
      RETRY_HINT,
      undefined,
      transport,
    ),
    /Exa search timed out after 0\.025 seconds\. Retry with backend: "firecrawl"\./,
  );
  assert.equal(requestSignal?.aborted, true);
});

test("propagates tool cancellation to the in-flight request", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const transport = {
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
  };

  await assert.rejects(
    exaSearch(
      keyProvider(),
      { query: "q", limit: 5 },
      RETRY_HINT,
      controller.signal,
      transport,
    ),
    /Exa search cancelled/,
  );
  assert.equal(requestSignal?.aborted, true);
});

test("reports cancellation distinctly from failures", async () => {
  const controller = new AbortController();
  const transport = {
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      controller.abort();
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
      void init;
    }) as typeof fetch,
  };

  await assert.rejects(
    exaSearch(
      keyProvider(),
      { query: "q", limit: 5 },
      RETRY_HINT,
      controller.signal,
      transport,
    ),
    /Exa search cancelled/,
  );
});

test("memoizes the API key and appends the retry hint when it is missing", async () => {
  let lookups = 0;
  const getKey = createExaKeyProvider(
    {
      exec: async () => {
        lookups += 1;
        return {
          stdout: "infisical-exa\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      },
    },
    { env: {}, envPath: "/not-used" },
  );
  assert.equal(await getKey(), "infisical-exa");
  assert.equal(await getKey(), "infisical-exa");
  assert.equal(lookups, 1);

  const missing = createExaKeyProvider(
    {
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    },
    { env: {}, envPath: "/not-used" },
  );
  await assert.rejects(
    exaSearch(missing, { query: "q", limit: 5 }, RETRY_HINT),
    /Missing EXA_API_KEY.*Retry with backend: "firecrawl"\./,
  );
});
