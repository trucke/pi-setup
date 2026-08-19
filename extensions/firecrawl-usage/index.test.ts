import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FIRECRAWL_BUDGET,
  FIRECRAWL_USAGE_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";
import { HERDR_BLOCKED_CHANNEL } from "../shared/herdr.ts";
import firecrawlUsage, {
  creditsForFirecrawlResult,
  estimatedCreditsForCall,
  usageForEntries,
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

function customEntry(customType: string, data: unknown, id: string) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    data,
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

test("estimates Firecrawl calls conservatively", () => {
  assert.equal(estimatedCreditsForCall("firecrawl_search", { limit: 5 }), 2);
  assert.equal(estimatedCreditsForCall("firecrawl_search", { limit: 11 }), 4);
  assert.equal(
    estimatedCreditsForCall("firecrawl_search", {
      limit: 3,
      scrapeResults: true,
    }),
    5,
  );
  assert.equal(estimatedCreditsForCall("firecrawl_scrape", {}), 1);
  assert.equal(estimatedCreditsForCall("firecrawl_crawl", {}), 5);
  assert.equal(estimatedCreditsForCall("firecrawl_crawl", { limit: 12 }), 12);
  assert.equal(estimatedCreditsForCall("read", {}), 0);
});

test("uses reported credits and treats local cache hits as free", () => {
  assert.equal(
    creditsForFirecrawlResult("firecrawl_scrape", {
      metadata: { creditsUsed: 1 },
    }),
    1,
  );
  assert.equal(
    creditsForFirecrawlResult("firecrawl_scrape", {
      localCacheHit: true,
      metadata: { creditsUsed: 0 },
    }),
    0,
  );
  assert.equal(
    creditsForFirecrawlResult(
      "firecrawl_crawl",
      { localBudgetBlocked: true },
      { limit: 100 },
      true,
    ),
    0,
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

test("calculates search credits even for empty or legacy scraped results", () => {
  assert.equal(
    creditsForFirecrawlResult("firecrawl_search", { web: [] }, { limit: 5 }),
    2,
  );
  assert.equal(
    creditsForFirecrawlResult(
      "firecrawl_search",
      {
        web: Array.from({ length: 11 }, () => ({ url: "https://example.com" })),
      },
      { limit: 11 },
    ),
    4,
  );
  assert.equal(
    creditsForFirecrawlResult(
      "firecrawl_search",
      { web: [{ markdown: "one" }, { markdown: "two" }] },
      { limit: 2, scrapeResults: true },
    ),
    4,
  );
});

test("reconstructs irreversible spend from all entries including failures", () => {
  const usage = usageForEntries([
    toolCallEntry("search-1", "firecrawl_search", { limit: 5 }),
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
    toolCallEntry("failed-1", "firecrawl_crawl", { limit: 20 }),
    toolResultEntry({
      id: "failed-1",
      name: "firecrawl_crawl",
      isError: true,
    }),
  ]);

  assert.equal(usage.creditsUsed, 23);
  assert.deepEqual(
    usage.toolCallIds,
    new Set(["search-1", "scrape-1", "failed-1"]),
  );
});

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

function createHarness(
  entries: SessionEntry[],
  options: {
    hasUI?: boolean;
    select?: (
      choices: readonly string[],
    ) => string | undefined | Promise<string | undefined>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, (value: unknown) => void>();
  const emitted: Array<{ name: string; value: unknown }> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const selections: Array<{ title: string; choices: readonly string[] }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
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
    hasUI: options.hasUI ?? true,
    sessionManager: { getEntries: () => entries },
    ui: {
      select: async (title: string, choices: readonly string[]) => {
        selections.push({ title, choices });
        return options.select ? options.select(choices) : choices[0];
      },
    },
  } as unknown as ExtensionContext;

  firecrawlUsage(pi);

  const emit = async (name: string, event: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing ${name} handler`);
    return handler(event, ctx);
  };

  return { emit, emitted, eventHandlers, appended, selections };
}

function usageEvents(emitted: Array<{ name: string; value: unknown }>) {
  return emitted
    .filter(({ name }) => name === FIRECRAWL_USAGE_CHANNEL)
    .map(({ value }) => value);
}

function herdrEvents(emitted: Array<{ name: string; value: unknown }>) {
  return emitted
    .filter(({ name }) => name === HERDR_BLOCKED_CHANNEL)
    .map(({ value }) => value);
}

test("publishes restored and live usage without double counting", async () => {
  const entries = [
    toolCallEntry("scrape-1", "firecrawl_scrape"),
    toolResultEntry({
      id: "scrape-1",
      name: "firecrawl_scrape",
      details: { metadata: { creditsUsed: 1 } },
    }),
  ];
  const { emit, emitted, eventHandlers } = createHarness(entries);

  await emit("session_start", { type: "session_start", reason: "startup" });
  await emit("tool_call", {
    toolCallId: "search-2",
    toolName: "firecrawl_search",
    input: { limit: 5 },
  });
  await emit("tool_result", {
    toolCallId: "search-2",
    toolName: "firecrawl_search",
    input: { limit: 5 },
    details: { web: [{ url: "https://example.com" }] },
    content: [],
    isError: false,
  });
  await emit("tool_result", {
    toolCallId: "search-2",
    toolName: "firecrawl_search",
    input: { limit: 5 },
    details: { web: [{ url: "https://example.com" }] },
    content: [],
    isError: false,
  });
  eventHandlers.get(REFRESH_CHANNEL)?.(undefined);

  assert.deepEqual(usageEvents(emitted), [
    {
      creditsUsed: 1,
      budget: DEFAULT_FIRECRAWL_BUDGET,
      unlimited: false,
    },
    {
      creditsUsed: 3,
      budget: DEFAULT_FIRECRAWL_BUDGET,
      unlimited: false,
    },
    {
      creditsUsed: 3,
      budget: DEFAULT_FIRECRAWL_BUDGET,
      unlimited: false,
    },
  ]);
});

test("tree navigation preserves spend from all session entries", async () => {
  const entries: SessionEntry[] = [];
  const { emit, emitted } = createHarness(entries);

  await emit("session_start", { type: "session_start", reason: "startup" });
  entries.push(
    toolCallEntry("crawl-1", "firecrawl_crawl", { limit: 8 }),
    toolResultEntry({
      id: "crawl-1",
      name: "firecrawl_crawl",
      details: { creditsUsed: 8 },
    }),
  );
  await emit("session_tree", {
    type: "session_tree",
    newLeafId: "result-crawl-1",
    oldLeafId: null,
  });

  assert.deepEqual(usageEvents(emitted), [
    {
      creditsUsed: 0,
      budget: DEFAULT_FIRECRAWL_BUDGET,
      unlimited: false,
    },
    {
      creditsUsed: 8,
      budget: DEFAULT_FIRECRAWL_BUDGET,
      unlimited: false,
    },
  ]);
});

test("restores approved budget settings from session entries", async () => {
  const { emit, emitted } = createHarness([
    customEntry("firecrawl-budget", { budget: 35 }, "budget-1"),
    customEntry("firecrawl-budget", { unlimited: true }, "budget-2"),
  ]);

  await emit("session_start", { type: "session_start", reason: "startup" });

  assert.deepEqual(usageEvents(emitted), [
    { creditsUsed: 0, budget: 35, unlimited: true },
  ]);
});

test("reserves parallel calls and persists an approved budget increase", async () => {
  const { emit, emitted, appended } = createHarness([]);
  await emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(
    await emit("tool_call", {
      toolCallId: "crawl-1",
      toolName: "firecrawl_crawl",
      input: { limit: 20 },
    }),
    undefined,
  );
  assert.equal(
    await emit("tool_call", {
      toolCallId: "scrape-1",
      toolName: "firecrawl_scrape",
      input: {},
    }),
    undefined,
  );

  assert.deepEqual(appended, [
    { customType: "firecrawl-budget", data: { budget: 25 } },
  ]);
  assert.deepEqual(usageEvents(emitted).at(-1), {
    creditsUsed: 0,
    budget: 25,
    unlimited: false,
  });
  assert.deepEqual(herdrEvents(emitted), [
    {
      active: true,
      label: "Waiting for Firecrawl budget approval",
    },
    { active: false },
  ]);
});

test("allows all remaining Firecrawl requests for the current session", async () => {
  const harness = createHarness([], {
    select: (choices) => choices[1],
  });
  await harness.emit("session_start", {
    type: "session_start",
    reason: "startup",
  });

  assert.equal(
    await harness.emit("tool_call", {
      toolCallId: "crawl-1",
      toolName: "firecrawl_crawl",
      input: { limit: 21 },
    }),
    undefined,
  );
  assert.equal(
    await harness.emit("tool_call", {
      toolCallId: "crawl-2",
      toolName: "firecrawl_crawl",
      input: { limit: 100 },
    }),
    undefined,
  );

  assert.deepEqual(harness.appended, [
    { customType: "firecrawl-budget", data: { unlimited: true } },
  ]);
  assert.equal(harness.selections.length, 1);
  assert.deepEqual(harness.selections[0]?.choices.slice(1), [
    "Allow all Firecrawl requests for this session",
    "Decline this request",
  ]);
  assert.deepEqual(usageEvents(harness.emitted).at(-1), {
    creditsUsed: 0,
    budget: DEFAULT_FIRECRAWL_BUDGET,
    unlimited: true,
  });
});

test("blocks budget overruns without approval", async () => {
  const noUi = createHarness([], { hasUI: false });
  await noUi.emit("session_start", {
    type: "session_start",
    reason: "startup",
  });
  const unavailable = await noUi.emit("tool_call", {
    toolCallId: "crawl-1",
    toolName: "firecrawl_crawl",
    input: { limit: 21 },
  });
  assert.deepEqual(unavailable, {
    block: true,
    reason:
      "Firecrawl request blocked: projected usage is 21 credits, above the 20-credit session budget. Reduce the scope or approve a higher budget in an interactive session.",
  });
  assert.deepEqual(
    await noUi.emit("tool_result", {
      toolCallId: "crawl-1",
      toolName: "firecrawl_crawl",
      input: { limit: 21 },
      isError: true,
    }),
    { details: { localBudgetBlocked: true } },
  );
  assert.deepEqual(usageEvents(noUi.emitted).at(-1), {
    creditsUsed: 0,
    budget: DEFAULT_FIRECRAWL_BUDGET,
    unlimited: false,
  });

  const declined = createHarness([], {
    select: (choices) => choices[2],
  });
  await declined.emit("session_start", {
    type: "session_start",
    reason: "startup",
  });
  const result = await declined.emit("tool_call", {
    toolCallId: "crawl-2",
    toolName: "firecrawl_crawl",
    input: { limit: 21 },
  });
  assert.deepEqual(result, {
    block: true,
    reason:
      "Firecrawl request declined because projected usage exceeds the 20-credit session budget.",
  });
  assert.deepEqual(declined.appended, []);
  assert.deepEqual(herdrEvents(declined.emitted), [
    {
      active: true,
      label: "Waiting for Firecrawl budget approval",
    },
    { active: false },
  ]);
});

test("clears the blocked state when budget confirmation fails", async () => {
  const confirmationError = new Error("confirmation failed");
  const harness = createHarness([], {
    select: async () => {
      throw confirmationError;
    },
  });

  await assert.rejects(
    harness.emit("tool_call", {
      toolCallId: "crawl-1",
      toolName: "firecrawl_crawl",
      input: { limit: 21 },
    }),
    confirmationError,
  );
  assert.deepEqual(herdrEvents(harness.emitted), [
    {
      active: true,
      label: "Waiting for Firecrawl budget approval",
    },
    { active: false },
  ]);
});

test("counts failed calls conservatively and cached calls as free", async () => {
  const { emit, emitted } = createHarness([]);
  await emit("session_start", { type: "session_start", reason: "startup" });

  await emit("tool_call", {
    toolCallId: "crawl-1",
    toolName: "firecrawl_crawl",
    input: { limit: 7 },
  });
  await emit("tool_result", {
    toolCallId: "crawl-1",
    toolName: "firecrawl_crawl",
    input: { limit: 7 },
    isError: true,
  });
  await emit("tool_call", {
    toolCallId: "scrape-1",
    toolName: "firecrawl_scrape",
    input: {},
  });
  await emit("tool_result", {
    toolCallId: "scrape-1",
    toolName: "firecrawl_scrape",
    input: {},
    details: {
      localCacheHit: true,
      metadata: { creditsUsed: 0 },
    },
    isError: false,
  });

  assert.deepEqual(usageEvents(emitted).at(-1), {
    creditsUsed: 7,
    budget: DEFAULT_FIRECRAWL_BUDGET,
    unlimited: false,
  });
});
