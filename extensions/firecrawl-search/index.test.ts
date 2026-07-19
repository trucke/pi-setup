import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import firecrawlTools, {
  crawlEffect,
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

test("registers namespaced tool names", () => {
  const names: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
  } as unknown as ExtensionAPI;

  firecrawlTools(pi);

  assert.deepEqual(names, [
    "firecrawl_search",
    "firecrawl_crawl",
    "firecrawl_scrape",
  ]);
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
