import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  FIRECRAWL_USAGE_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

const FIRECRAWL_TOOL_NAMES = new Set([
  "firecrawl_search",
  "firecrawl_scrape",
  "firecrawl_crawl",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function creditValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function searchResultGroups(details: unknown) {
  const result = record(details);
  if (!result) return [];

  return ["web", "news", "images"].map((source) => {
    const items = result[source];
    return Array.isArray(items) ? items : [];
  });
}

function searchCredits(details: unknown) {
  const result = record(details);
  const reported = creditValue(result?.creditsUsed);
  if (reported !== undefined) return reported;

  const groups = searchResultGroups(details);
  const baseCredits = groups.reduce(
    (total, items) =>
      total + (items.length === 0 ? 0 : Math.ceil(items.length / 10) * 2),
    0,
  );
  const scrapeCredits = groups.flat().reduce((total, item) => {
    const metadata = record(record(item)?.metadata);
    return total + (creditValue(metadata?.creditsUsed) ?? 0);
  }, 0);
  return baseCredits + scrapeCredits;
}

export function creditsForFirecrawlResult(toolName: string, details: unknown) {
  if (!FIRECRAWL_TOOL_NAMES.has(toolName)) return 0;

  const result = record(details);
  if (toolName === "firecrawl_search") {
    return searchCredits(details);
  }
  if (toolName === "firecrawl_crawl") {
    return creditValue(result?.creditsUsed) ?? 0;
  }

  const metadata = record(result?.metadata);
  return creditValue(metadata?.creditsUsed) ?? 0;
}

export function usageForBranch(entries: readonly SessionEntry[]) {
  const toolCallIds = new Set<string>();
  let creditsUsed = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (
      message.role !== "toolResult" ||
      message.isError ||
      !FIRECRAWL_TOOL_NAMES.has(message.toolName) ||
      toolCallIds.has(message.toolCallId)
    ) {
      continue;
    }

    toolCallIds.add(message.toolCallId);
    creditsUsed += creditsForFirecrawlResult(message.toolName, message.details);
  }

  return { creditsUsed, toolCallIds };
}

export default function firecrawlUsage(pi: ExtensionAPI) {
  let creditsUsed = 0;
  let toolCallIds = new Set<string>();

  const publish = () =>
    pi.events.emit(FIRECRAWL_USAGE_CHANNEL, { creditsUsed });

  const restore = (ctx: ExtensionContext) => {
    const restored = usageForBranch(ctx.sessionManager.getBranch());
    creditsUsed = restored.creditsUsed;
    toolCallIds = restored.toolCallIds;
    publish();
  };

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, publish);

  pi.on("session_start", (_event, ctx) => restore(ctx));

  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("tool_result", (event) => {
    if (
      event.isError ||
      !FIRECRAWL_TOOL_NAMES.has(event.toolName) ||
      toolCallIds.has(event.toolCallId)
    ) {
      return;
    }

    toolCallIds.add(event.toolCallId);
    creditsUsed += creditsForFirecrawlResult(event.toolName, event.details);
    publish();
  });

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    creditsUsed = 0;
    toolCallIds.clear();
  });
}
