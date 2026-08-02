import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  FIRECRAWL_USAGE_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";
import firecrawlUsage, {
  creditsForFirecrawlResult,
  usageForBranch,
} from "./index.ts";

function messageEntry(message: Record<string, unknown>, id: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  } as unknown as SessionEntry;
}

function toolCallEntry(
  id: string,
  name: string,
  arguments_: Record<string, unknown> = {},
) {
  return messageEntry(
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: arguments_ }],
    },
    `assistant-${id}`,
  );
}

function toolResultEntry(options: {
  id: string;
  name: string;
  details?: unknown;
  isError?: boolean;
}) {
  return messageEntry(
    {
      role: "toolResult",
      toolCallId: options.id,
      toolName: options.name,
      content: [],
      details: options.details,
      isError: options.isError ?? false,
    },
    `result-${options.id}`,
  );
}

test("extracts reported scrape and crawl credits", () => {
  assert.equal(
    creditsForFirecrawlResult("firecrawl_scrape", {
      metadata: { creditsUsed: 1 },
    }),
    1,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_crawl", {
      creditsUsed: 7,
      data: [{ metadata: { creditsUsed: 1 } }],
    }),
    7,
  );
  assert.equal(creditsForFirecrawlResult("read", { creditsUsed: 99 }), 0);
});

test("calculates search and optional result-scrape credits", () => {
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", {
      web: Array.from({ length: 5 }, () => ({ url: "https://example.com" })),
    }),
    2,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", {
      web: Array.from({ length: 11 }, () => ({ url: "https://example.com" })),
    }),
    4,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", {
      web: Array.from({ length: 5 }, () => ({ url: "https://example.com" })),
      news: Array.from({ length: 5 }, () => ({ url: "https://example.com" })),
    }),
    4,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", {
      web: [
        { markdown: "one", metadata: { creditsUsed: 1 } },
        { markdown: "two", metadata: { creditsUsed: 2 } },
      ],
    }),
    5,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", {
      web: [{ markdown: "one" }, { markdown: "two" }],
    }),
    2,
  );
});

test("reconstructs usage from the active branch", () => {
  const usage = usageForBranch([
    toolCallEntry("search-1", "firecrawl_search"),
    toolResultEntry({
      id: "search-1",
      name: "firecrawl_search",
      details: { web: [{ url: "https://example.com" }] },
    }),
    toolCallEntry("scrape-1", "firecrawl_scrape"),
    toolResultEntry({
      id: "scrape-1",
      name: "firecrawl_scrape",
      details: { metadata: { creditsUsed: 1 } },
    }),
    toolResultEntry({
      id: "failed-1",
      name: "firecrawl_crawl",
      details: { creditsUsed: 20 },
      isError: true,
    }),
  ]);

  assert.equal(usage.creditsUsed, 3);
  assert.deepEqual(usage.toolCallIds, new Set(["search-1", "scrape-1"]));
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => void;

function createHarness(branch: SessionEntry[]) {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  const emitted: Array<{ name: string; value: unknown }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
      emit(name: string, value: unknown) {
        emitted.push({ name, value });
        eventHandlers.get(name)?.(value);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;

  firecrawlUsage(pi);

  const emit = (name: string, event: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing ${name} handler`);
    handler(event, ctx);
  };

  return { emit, emitted, eventHandlers };
}

test("publishes restored and live session usage without double counting", () => {
  const branch = [
    toolCallEntry("scrape-1", "firecrawl_scrape"),
    toolResultEntry({
      id: "scrape-1",
      name: "firecrawl_scrape",
      details: { metadata: { creditsUsed: 1 } },
    }),
  ];
  const { emit, emitted, eventHandlers } = createHarness(branch);

  emit("session_start", { type: "session_start", reason: "startup" });
  emit("tool_result", {
    type: "tool_result",
    toolCallId: "search-2",
    toolName: "firecrawl_search",
    input: { limit: 5 },
    details: { web: [{ url: "https://example.com" }] },
    content: [],
    isError: false,
  });
  emit("tool_result", {
    type: "tool_result",
    toolCallId: "search-2",
    toolName: "firecrawl_search",
    input: { limit: 5 },
    details: { web: [{ url: "https://example.com" }] },
    content: [],
    isError: false,
  });
  eventHandlers.get(REFRESH_CHANNEL)?.(undefined);

  assert.deepEqual(
    emitted
      .filter(({ name }) => name === FIRECRAWL_USAGE_CHANNEL)
      .map(({ value }) => value),
    [{ creditsUsed: 1 }, { creditsUsed: 3 }, { creditsUsed: 3 }],
  );
});

test("recomputes usage after tree navigation", () => {
  const branch: SessionEntry[] = [];
  const { emit, emitted } = createHarness(branch);

  emit("session_start", { type: "session_start", reason: "startup" });
  branch.push(
    toolCallEntry("crawl-1", "firecrawl_crawl"),
    toolResultEntry({
      id: "crawl-1",
      name: "firecrawl_crawl",
      details: { creditsUsed: 8 },
    }),
  );
  emit("session_tree", {
    type: "session_tree",
    newLeafId: "result-crawl-1",
    oldLeafId: null,
  });

  assert.deepEqual(
    emitted.map(({ value }) => value),
    [{ creditsUsed: 0 }, { creditsUsed: 8 }],
  );
});
