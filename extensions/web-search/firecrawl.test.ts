import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { resolveApiKey } from "./env.ts";
import {
  crawlEffect,
  createFirecrawlProvider,
  runFirecrawl,
  type CrawlClient,
} from "./firecrawl.ts";

function makeExecutor(exec: Pick<ExtensionAPI, "exec">["exec"]) {
  return { exec };
}

function testClientProvider() {
  return createFirecrawlProvider(
    makeExecutor(async () => ({
      stdout: "",
      stderr: "",
      code: 1,
      killed: false,
    })),
    { env: { FIRECRAWL_API_KEY: "test-key" }, envPath: "/not-used" },
  );
}

test("uses the process environment before other credential sources", async () => {
  let executed = false;
  const pi = makeExecutor(async () => {
    executed = true;
    return { stdout: "", stderr: "", code: 1, killed: false };
  });

  const apiKey = await resolveApiKey("FIRECRAWL_API_KEY", pi, undefined, {
    env: { FIRECRAWL_API_KEY: "env-key" },
    envPath: "/not-used",
  });

  assert.equal(apiKey, "env-key");
  assert.equal(executed, false);
});

test("uses Infisical before the env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-search-test-"));
  const envPath = join(directory, ".env");

  try {
    await writeFile(envPath, "FIRECRAWL_API_KEY=file-key\n", "utf8");
    const pi = makeExecutor(async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), [
        "secrets",
        "get",
        "FIRECRAWL_API_KEY",
      ]);
      return {
        stdout: "infisical-key\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    });

    const apiKey = await resolveApiKey("FIRECRAWL_API_KEY", pi, undefined, {
      env: {},
      envPath,
    });
    assert.equal(apiKey, "infisical-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("falls back to the env file when Infisical is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-search-test-"));
  const envPath = join(directory, ".env");

  try {
    await writeFile(envPath, "FIRECRAWL_API_KEY=file-key\n", "utf8");
    const pi = makeExecutor(async () => {
      throw new Error("infisical unavailable");
    });

    const apiKey = await resolveApiKey("FIRECRAWL_API_KEY", pi, undefined, {
      env: {},
      envPath,
    });
    assert.equal(apiKey, "file-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("names all credential sources when the key is missing", async () => {
  const pi = makeExecutor(async () => ({
    stdout: "",
    stderr: "",
    code: 1,
    killed: false,
  }));

  await assert.rejects(
    resolveApiKey("EXA_API_KEY", pi, undefined, {
      env: {},
      envPath: "/not-used",
    }),
    /Missing EXA_API_KEY in the process environment, Infisical, or ~\/\.pi\/agent\/\.env/,
  );
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
  const getClient = createFirecrawlProvider(pi, {
    env: {},
    envPath: "/not-used",
  });

  const [first, second] = await Promise.all([getClient(), getClient()]);

  assert.strictEqual(second, first);
  assert.equal(executions, 1);
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

test("bounds Firecrawl operations with an explicit timeout", async () => {
  const getClient = testClientProvider();

  await assert.rejects(
    runFirecrawl(
      getClient,
      "search",
      "Searching",
      25,
      "Retry web-search.",
      undefined,
      undefined,
      () => Effect.never,
    ),
    /Firecrawl search timed out after 0\.025 seconds\. Retry web-search\./,
  );
});

test("Firecrawl cancellation cleans up its request timeout", async () => {
  const getClient = testClientProvider();
  await getClient();

  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const controller = new AbortController();
  const timeoutCount = () =>
    process.getActiveResourcesInfo().filter((type) => type === "Timeout")
      .length;
  const before = timeoutCount();

  const running = runFirecrawl(
    getClient,
    "search",
    "Searching",
    120_000,
    "Retry web-search.",
    controller.signal,
    undefined,
    () => Effect.sync(requestStarted).pipe(Effect.andThen(Effect.never)),
  );

  await started;
  controller.abort();
  await assert.rejects(running, /Firecrawl request cancelled/);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(timeoutCount(), before);
});

test("failed remote crawl status fails the effect and triggers cleanup", async () => {
  const cancelledJobs: string[] = [];
  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-failed", url }),
    getCrawlStatus: async () => ({
      id: "crawl-failed",
      status: "failed",
      completed: 0,
      total: 1,
      creditsUsed: 0,
      expiresAt: new Date().toISOString(),
      data: [],
    }),
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  await assert.rejects(
    Effect.runPromise(crawlEffect(client, "https://example.com", {})),
    /ended with status failed/,
  );
  assert.deepEqual(cancelledJobs, ["crawl-failed"]);
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
