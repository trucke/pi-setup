import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "./index.ts";
import { registerFetchTool } from "./fetch.ts";
import { registerSearchTool } from "./search.ts";
import type { ScrapeCache } from "./cache.ts";
import { parsePublicHttpUrl } from "../shared/public-url.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
  ) => Promise<unknown>;
}

function makePi(tools: RegisteredTool[]) {
  return {
    on() {},
    events: { on: () => () => {}, emit() {} },
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
}

const LEGACY_NAMES = [
  "codex_research",
  "firecrawl_search",
  "firecrawl_scrape",
  "firecrawl_crawl",
];

test("registers exactly the four kebab-case web tools without legacy aliases", () => {
  const tools: RegisteredTool[] = [];
  webSearch(makePi(tools));

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web-research", "web-search", "web-fetch", "web-crawl"],
  );
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  }
  for (const legacy of LEGACY_NAMES) {
    assert.ok(
      !tools.some((tool) => tool.name === legacy),
      `legacy alias ${legacy} must not be registered`,
    );
  }
});

test("exposes backend routing with exa as the default in the schemas", () => {
  const tools: RegisteredTool[] = [];
  webSearch(makePi(tools));

  const search = tools.find((tool) => tool.name === "web-search");
  assert.ok(search);
  assert.deepEqual(Object.keys(search.parameters?.properties ?? {}), [
    "query",
    "backend",
    "limit",
    "source",
    "includeDomains",
    "excludeDomains",
    "recency",
  ]);
  const searchBackend = search.parameters?.properties?.backend as {
    enum?: string[];
    description?: string;
  };
  assert.deepEqual(searchBackend.enum, ["exa", "firecrawl"]);
  assert.match(searchBackend.description ?? "", /Defaults to "exa"/);
  assert.equal(
    (search.parameters?.properties?.limit as { maximum?: number }).maximum,
    10,
  );

  const fetch = tools.find((tool) => tool.name === "web-fetch");
  assert.ok(fetch);
  assert.deepEqual(Object.keys(fetch.parameters?.properties ?? {}), [
    "url",
    "backend",
    "fresh",
    "maxCharacters",
    "onlyMainContent",
    "waitFor",
    "timeout",
    "includeMetadata",
  ]);
  const fetchBackend = fetch.parameters?.properties?.backend as {
    enum?: string[];
  };
  assert.deepEqual(fetchBackend.enum, ["exa", "firecrawl"]);

  const crawl = tools.find((tool) => tool.name === "web-crawl");
  assert.match(crawl?.description ?? "", /Defaults to 5 pages/);
  assert.match(crawl?.description ?? "", /Firecrawl credit/);

  const research = tools.find((tool) => tool.name === "web-research");
  assert.deepEqual(Object.keys(research?.parameters?.properties ?? {}), [
    "query",
    "maxSources",
  ]);

  // One source of routing guidance: attached to web-search, not repeated.
  assert.ok(
    search.promptGuidelines?.some((line) => line.includes("web-research")),
  );
  assert.ok(
    !fetch.promptGuidelines?.some((line) => line.includes("web-research")),
  );
});

function stubDependencies(overrides: { fetchImpl?: typeof fetch } = {}) {
  let firecrawlCalls = 0;
  return {
    firecrawlCallCount: () => firecrawlCalls,
    getFirecrawl: async () => {
      firecrawlCalls += 1;
      throw new Error("firecrawl must not be constructed in this test");
    },
    getExaKey: async () => "exa-key",
    scrapeCache: new Map() as ScrapeCache,
    transport: {
      fetch:
        overrides.fetchImpl ??
        ((async () => new Response("boom", { status: 500 })) as typeof fetch),
    },
  };
}

test("rejects private, credentialed, and non-HTTP web URLs", async () => {
  assert.throws(
    () => parsePublicHttpUrl("http://127.0.0.1/admin", "Web URL"),
    /destination is not public/,
  );
  assert.throws(
    () => parsePublicHttpUrl("https://secret.internal/docs", "Web URL"),
    /destination is not public/,
  );
  assert.throws(
    () => parsePublicHttpUrl("https://user:secret@example.com", "Web URL"),
    /embedded credentials/,
  );
  assert.throws(
    () => parsePublicHttpUrl("file:///tmp/private", "Web URL"),
    /HTTP or HTTPS/,
  );

  const tools: RegisteredTool[] = [];
  const deps = stubDependencies();
  registerFetchTool(makePi(tools), deps);
  const fetchTool = tools.find((tool) => tool.name === "web-fetch");
  assert.ok(fetchTool);
  await assert.rejects(
    fetchTool.execute(
      "private-fetch",
      { url: "http://localhost/admin" },
      undefined,
      undefined,
    ),
    /destination is not public/,
  );
  assert.equal(deps.firecrawlCallCount(), 0);
});

test("rejects backend-incompatible parameters with explicit retries", async () => {
  const tools: RegisteredTool[] = [];
  const deps = stubDependencies();
  const pi = makePi(tools);
  registerSearchTool(pi, deps);
  registerFetchTool(pi, deps);

  const search = tools.find((tool) => tool.name === "web-search");
  const fetchTool = tools.find((tool) => tool.name === "web-fetch");
  assert.ok(search && fetchTool);

  await assert.rejects(
    search.execute(
      "conflicting-domains",
      {
        query: "q",
        includeDomains: ["a.dev"],
        excludeDomains: ["b.dev"],
      },
      undefined,
      undefined,
    ),
    /cannot combine includeDomains and excludeDomains/,
  );
  await assert.rejects(
    search.execute(
      "images-on-exa",
      { query: "q", source: "images" },
      undefined,
      undefined,
    ),
    /no structured "images" source.*backend: "firecrawl"/,
  );
  await assert.rejects(
    fetchTool.execute(
      "wait-on-exa",
      { url: "https://example.com", waitFor: 1_000 },
      undefined,
      undefined,
    ),
    /waitFor only applies to the firecrawl backend/,
  );
  await assert.rejects(
    fetchTool.execute(
      "chars-on-firecrawl",
      { url: "https://example.com", backend: "firecrawl", maxCharacters: 10 },
      undefined,
      undefined,
    ),
    /maxCharacters only applies to the exa backend/,
  );
  assert.equal(deps.firecrawlCallCount(), 0);
});

test("never falls back to Firecrawl when the default Exa backend fails", async () => {
  const tools: RegisteredTool[] = [];
  const deps = stubDependencies();
  const pi = makePi(tools);
  registerSearchTool(pi, deps);
  registerFetchTool(pi, deps);

  const search = tools.find((tool) => tool.name === "web-search");
  const fetchTool = tools.find((tool) => tool.name === "web-fetch");
  assert.ok(search && fetchTool);

  await assert.rejects(
    search.execute("exa-search-fails", { query: "q" }, undefined, undefined),
    /Exa search failed \(HTTP 500\).*backend: "firecrawl"/,
  );
  await assert.rejects(
    fetchTool.execute(
      "exa-fetch-fails",
      { url: "https://example.com" },
      undefined,
      undefined,
    ),
    /Exa fetch failed \(HTTP 500\).*backend: "firecrawl"/,
  );
  assert.equal(deps.firecrawlCallCount(), 0);
});

test("returns normalized exa details from a successful search", async () => {
  const tools: RegisteredTool[] = [];
  const deps = stubDependencies({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "One",
              url: "https://example.com/one",
              highlights: ["highlight"],
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  registerSearchTool(makePi(tools), deps);

  const search = tools.find((tool) => tool.name === "web-search");
  assert.ok(search);
  const result = (await search.execute(
    "exa-search-ok",
    { query: "q" },
    undefined,
    undefined,
  )) as {
    content: Array<{ type: string; text: string }>;
    details: { backend: string; results: Array<{ url: string }> };
  };

  assert.equal(result.details.backend, "exa");
  assert.deepEqual(
    result.details.results.map((item) => item.url),
    ["https://example.com/one"],
  );
  assert.match(result.content[0].text, /1\. \[web\] One/);
  assert.match(result.content[0].text, /highlight/);
  assert.equal(deps.firecrawlCallCount(), 0);
});
