import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  memoizedRequest,
  restoreScrapeCache,
  scrapeRequestKey,
  seedFirecrawlResult,
  type ScrapeCache,
} from "./cache.ts";

function toolCallEntry(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: arguments_ }],
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(id: string, name: string, details: unknown) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError: false,
      details,
    },
  } as unknown as SessionEntry;
}

test("normalizes equivalent scrape requests without merging distinct options", () => {
  assert.equal(
    scrapeRequestKey({ url: " https://EXAMPLE.com/docs#first " }),
    scrapeRequestKey({
      url: "https://example.com/docs#second",
      onlyMainContent: true,
      waitFor: 0,
      timeout: 30_000,
    }),
  );
  assert.notEqual(
    scrapeRequestKey({ url: "https://example.com/docs", waitFor: 1_000 }),
    scrapeRequestKey({ url: "https://example.com/docs", waitFor: 0 }),
  );
});

test("reuses completed and in-flight requests but evicts failures", async () => {
  const cache = new Map<string, Promise<string>>();
  let calls = 0;
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((complete) => {
    resolve = complete;
  });
  const request = () => {
    calls += 1;
    return pending;
  };

  const first = memoizedRequest(cache, "page", request);
  const concurrent = memoizedRequest(cache, "page", request);
  assert.equal(calls, 1);

  resolve("content");
  assert.deepEqual(await first, { value: "content", cacheHit: false });
  assert.deepEqual(await concurrent, { value: "content", cacheHit: true });
  assert.deepEqual(await memoizedRequest(cache, "page", request), {
    value: "content",
    cacheHit: true,
  });
  assert.equal(calls, 1);

  let attempts = 0;
  await assert.rejects(
    memoizedRequest(cache, "retry", async () => {
      attempts += 1;
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.deepEqual(
    await memoizedRequest(cache, "retry", async () => {
      attempts += 1;
      return "recovered";
    }),
    { value: "recovered", cacheHit: false },
  );
  assert.equal(attempts, 2);
});

test("restores direct fetches and seeds pages returned by crawls", async () => {
  const cache: ScrapeCache = new Map();
  const entries = [
    toolCallEntry("fetch-1", "web-fetch", {
      url: "https://example.com/docs",
      backend: "firecrawl",
    }),
    toolResultEntry("fetch-1", "web-fetch", {
      markdown: "Direct content",
      metadata: { sourceURL: "https://example.com/docs" },
    }),
    toolCallEntry("fetch-2", "web-fetch", {
      url: "https://example.com/docs",
      backend: "firecrawl",
      fresh: true,
    }),
    toolResultEntry("fetch-2", "web-fetch", {
      markdown: "Fresh content",
      metadata: { sourceURL: "https://example.com/docs" },
    }),
  ];

  assert.equal(restoreScrapeCache(cache, entries), 1);
  assert.equal(
    (await cache.get(scrapeRequestKey({ url: "https://example.com/docs" })))
      ?.markdown,
    "Fresh content",
  );

  assert.equal(
    seedFirecrawlResult(
      cache,
      "web-crawl",
      { onlyMainContent: true },
      {
        data: [
          {
            markdown: "Crawled content",
            metadata: { sourceURL: "https://example.com/guide" },
          },
        ],
      },
    ),
    1,
  );
  assert.equal(
    (await cache.get(scrapeRequestKey({ url: "https://example.com/guide" })))
      ?.markdown,
    "Crawled content",
  );
});

test("restores sessions persisted under the legacy snake_case tool names", async () => {
  const cache: ScrapeCache = new Map();
  const entries = [
    toolCallEntry("scrape-1", "firecrawl_scrape", {
      url: "https://example.com/legacy",
    }),
    toolResultEntry("scrape-1", "firecrawl_scrape", {
      markdown: "Legacy scrape",
      metadata: { sourceURL: "https://example.com/legacy" },
    }),
    toolCallEntry("search-1", "firecrawl_search", { query: "legacy" }),
    toolResultEntry("search-1", "firecrawl_search", {
      web: [
        {
          markdown: "Legacy search scrape",
          metadata: { sourceURL: "https://example.com/searched" },
        },
      ],
    }),
    toolCallEntry("crawl-1", "firecrawl_crawl", {
      url: "https://example.com",
    }),
    toolResultEntry("crawl-1", "firecrawl_crawl", {
      data: [
        {
          markdown: "Legacy crawl page",
          metadata: { sourceURL: "https://example.com/crawled" },
        },
      ],
    }),
  ];

  assert.equal(restoreScrapeCache(cache, entries), 3);
  assert.equal(
    (await cache.get(scrapeRequestKey({ url: "https://example.com/legacy" })))
      ?.markdown,
    "Legacy scrape",
  );
  assert.equal(
    (await cache.get(scrapeRequestKey({ url: "https://example.com/crawled" })))
      ?.markdown,
    "Legacy crawl page",
  );
});

test("ignores exa-backed results and unrelated tools when seeding", () => {
  const cache: ScrapeCache = new Map();

  assert.equal(
    seedFirecrawlResult(
      cache,
      "web-fetch",
      { url: "https://example.com" },
      {
        backend: "exa",
        pages: [{ title: "Page", url: "https://example.com", characters: 10 }],
        errors: [],
      },
    ),
    0,
  );
  assert.equal(
    seedFirecrawlResult(
      cache,
      "web-search",
      { query: "q" },
      { backend: "exa", results: [] },
    ),
    0,
  );
  assert.equal(
    seedFirecrawlResult(
      cache,
      "read",
      {},
      { markdown: "not a web result", metadata: {} },
    ),
    0,
  );
  assert.equal(cache.size, 0);
});
