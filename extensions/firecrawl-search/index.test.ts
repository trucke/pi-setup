import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  memoizedRequest,
  restoreScrapeCache,
  scrapeRequestKey,
  seedFirecrawlResult,
  type ScrapeCache,
} from "./cache.ts";
import firecrawlTools, {
  crawlEffect,
  createClientProvider,
  resolveApiKey,
  type CrawlClient,
} from "./index.ts";

function makeExecutor(exec: Pick<ExtensionAPI, "exec">["exec"]) {
  return { exec };
}

test("uses the process environment before other credential sources", async () => {
  let executed = false;
  const pi = makeExecutor(async () => {
    executed = true;
    return { stdout: "", stderr: "", code: 1, killed: false };
  });

  const apiKey = await resolveApiKey(pi, undefined, {
    env: { FIRECRAWL_API_KEY: "env-key" },
    envPath: "/not-used",
  });

  assert.equal(apiKey, "env-key");
  assert.equal(executed, false);
});

test("uses Infisical before the env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-firecrawl-test-"));
  const envPath = join(directory, ".env");

  try {
    await writeFile(envPath, "FIRECRAWL_API_KEY=file-key\n", "utf8");
    const pi = makeExecutor(async () => ({
      stdout: "infisical-key\n",
      stderr: "",
      code: 0,
      killed: false,
    }));

    const apiKey = await resolveApiKey(pi, undefined, { env: {}, envPath });
    assert.equal(apiKey, "infisical-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("falls back to the env file when Infisical is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-firecrawl-test-"));
  const envPath = join(directory, ".env");

  try {
    await writeFile(envPath, "FIRECRAWL_API_KEY=file-key\n", "utf8");
    const pi = makeExecutor(async () => {
      throw new Error("infisical unavailable");
    });

    const apiKey = await resolveApiKey(pi, undefined, { env: {}, envPath });
    assert.equal(apiKey, "file-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses one Firecrawl client and credential lookup", async () => {
  let executions = 0;
  const pi = makeExecutor(async () => {
    executions += 1;
    return {
      stdout: "infisical-key\n",
      stderr: "",
      code: 0,
      killed: false,
    };
  });
  const getClient = createClientProvider(pi, {
    env: {},
    envPath: "/not-used",
  });

  const [first, second] = await Promise.all([getClient(), getClient()]);

  assert.strictEqual(second, first);
  assert.equal(executions, 1);
});

test("registers namespaced tools with conservative defaults", async () => {
  const tools: Array<{
    name: string;
    description: string;
    parameters?: { properties?: Record<string, unknown> };
    execute?: (
      toolCallId: string,
      params: {
        query: string;
        includeDomains?: string[];
        excludeDomains?: string[];
      },
      signal: AbortSignal | undefined,
      onUpdate: undefined,
    ) => Promise<unknown>;
  }> = [];
  const pi = {
    on() {},
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  firecrawlTools(pi);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["firecrawl_search", "firecrawl_crawl", "firecrawl_scrape"],
  );
  const search = tools.find((tool) => tool.name === "firecrawl_search");
  assert.ok(search);
  assert.deepEqual(Object.keys(search.parameters?.properties ?? {}), [
    "query",
    "limit",
    "source",
    "includeDomains",
    "excludeDomains",
    "recency",
  ]);
  assert.equal(
    (search.parameters?.properties?.limit as { maximum?: number } | undefined)
      ?.maximum,
    10,
  );
  assert.match(search.description, /query-relevant excerpt/);
  assert.match(search.description, /image results remain unchanged/i);
  assert.match(
    (
      search.parameters?.properties?.includeDomains as
        { description?: string } | undefined
    )?.description ?? "",
    /[Mm]utually exclusive/,
  );
  assert.ok(search.execute);
  await assert.rejects(
    search.execute(
      "search-conflicting-domains",
      {
        query: "Firecrawl",
        includeDomains: ["firecrawl.dev"],
        excludeDomains: ["example.com"],
      },
      undefined,
      undefined,
    ),
    /cannot combine includeDomains and excludeDomains/,
  );

  const crawl = tools.find((tool) => tool.name === "firecrawl_crawl");
  assert.match(crawl?.description ?? "", /Defaults to 5 pages/);

  const scrape = tools.find((tool) => tool.name === "firecrawl_scrape");
  assert.ok(scrape?.parameters?.properties?.fresh);
});

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

test("restores direct scrapes and seeds pages returned by crawls", async () => {
  const cache: ScrapeCache = new Map();
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "scrape-1",
            name: "firecrawl_scrape",
            arguments: { url: "https://example.com/docs" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "scrape-1",
        toolName: "firecrawl_scrape",
        isError: false,
        details: {
          markdown: "Direct content",
          metadata: { sourceURL: "https://example.com/docs" },
        },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "scrape-2",
            name: "firecrawl_scrape",
            arguments: { url: "https://example.com/docs", fresh: true },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "scrape-2",
        toolName: "firecrawl_scrape",
        isError: false,
        details: {
          markdown: "Fresh content",
          metadata: { sourceURL: "https://example.com/docs" },
        },
      },
    },
  ] as unknown as SessionEntry[];

  assert.equal(restoreScrapeCache(cache, entries), 1);
  assert.equal(
    (await cache.get(scrapeRequestKey({ url: "https://example.com/docs" })))
      ?.markdown,
    "Fresh content",
  );

  assert.equal(
    seedFirecrawlResult(
      cache,
      "firecrawl_crawl",
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

test("defers crawl pagination until the job reaches a terminal state", async () => {
  const pagination: unknown[] = [];
  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async (_jobId, options) => {
      pagination.push(options);
      return options
        ? {
            id: "crawl-123",
            status: "completed",
            completed: 2,
            total: 2,
            next: "next-page",
            data: [{ markdown: "first" }],
          }
        : {
            id: "crawl-123",
            status: "completed",
            completed: 2,
            total: 2,
            data: [{ markdown: "first" }, { markdown: "second" }],
          };
    },
    cancelCrawl: async () => true,
  };

  const result = await Effect.runPromise(
    crawlEffect(client, "https://example.com", { limit: 2 }),
  );

  assert.equal(result.data.length, 2);
  assert.deepEqual(pagination, [{ autoPaginate: false }, undefined]);
});

test("cancels the remote crawl when polling is interrupted", async () => {
  let pollingStarted!: () => void;
  const startedPolling = new Promise<void>((resolve) => {
    pollingStarted = resolve;
  });
  const cancelledJobs: string[] = [];

  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async () => {
      pollingStarted();
      return new Promise(() => undefined);
    },
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  const controller = new AbortController();
  const running = Effect.runPromise(
    crawlEffect(client, "https://example.com", { limit: 1 }),
    { signal: controller.signal },
  );
  const interrupted = assert.rejects(running);

  await startedPolling;
  controller.abort();
  await interrupted;

  assert.deepEqual(cancelledJobs, ["crawl-123"]);
});
