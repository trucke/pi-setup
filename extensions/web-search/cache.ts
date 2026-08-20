import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Document } from "firecrawl";

export type ScrapeCache = Map<string, Promise<Document>>;

export interface ScrapeRequest {
  url: string;
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
}

/**
 * Maps current and legacy persisted tool names to the cache-relevant
 * Firecrawl operation. Exa-backed calls produce no Firecrawl documents, so
 * seeding naturally no-ops on their details.
 */
function cacheOperation(toolName: string) {
  switch (toolName) {
    case "web-fetch":
    case "firecrawl_scrape":
      return "fetch";
    case "web-search":
    case "firecrawl_search":
      return "search";
    case "web-crawl":
    case "firecrawl_crawl":
      return "crawl";
    default:
      return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDocument(value: unknown): value is Document {
  return typeof record(value)?.markdown === "string";
}

function sourceUrl(document: Document) {
  const metadata = record(document.metadata);
  return (
    stringValue(metadata?.sourceURL) ??
    stringValue(metadata?.url) ??
    stringValue(metadata?.ogUrl)
  );
}

export function scrapeRequestKey(request: ScrapeRequest) {
  let url = request.url.trim();
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    url = parsed.toString();
  } catch {
    // Firecrawl will report invalid URLs; keep the original value as the key.
  }

  return JSON.stringify({
    url,
    onlyMainContent: request.onlyMainContent ?? true,
    waitFor: request.waitFor ?? 0,
    timeout: request.timeout ?? 30_000,
  });
}

export function memoizedRequest<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  request: () => Promise<T>,
) {
  const cached = cache.get(key);
  if (cached) {
    return cached.then((value) => ({ value, cacheHit: true }));
  }

  const pending = request();
  cache.set(key, pending);
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending.then((value) => ({ value, cacheHit: false }));
}

function cacheDocument(
  cache: ScrapeCache,
  document: Document,
  request: ScrapeRequest,
) {
  const key = scrapeRequestKey(request);
  const added = !cache.has(key);
  cache.set(key, Promise.resolve(document));
  return added;
}

export function seedFirecrawlResult(
  cache: ScrapeCache,
  toolName: string,
  input: unknown,
  details: unknown,
) {
  const operation = cacheOperation(toolName);
  const request = record(input);

  if (operation === "fetch") {
    const url = stringValue(request?.url);
    if (!url || !isDocument(details)) return 0;
    return cacheDocument(cache, details, {
      url,
      onlyMainContent:
        typeof request?.onlyMainContent === "boolean"
          ? request.onlyMainContent
          : undefined,
      waitFor:
        typeof request?.waitFor === "number" ? request.waitFor : undefined,
      timeout:
        typeof request?.timeout === "number" ? request.timeout : undefined,
    })
      ? 1
      : 0;
  }

  const result = record(details);
  const candidates =
    operation === "crawl"
      ? [result?.data]
      : operation === "search"
        ? [result?.web, result?.news, result?.images]
        : [];
  const onlyMainContent =
    typeof request?.onlyMainContent === "boolean"
      ? request.onlyMainContent
      : undefined;
  let added = 0;

  for (const group of candidates) {
    if (!Array.isArray(group)) continue;
    for (const candidate of group) {
      if (!isDocument(candidate)) continue;
      const url = sourceUrl(candidate);
      if (!url) continue;
      if (cacheDocument(cache, candidate, { url, onlyMainContent })) added += 1;
    }
  }

  return added;
}

function webToolCalls(entries: readonly SessionEntry[]) {
  const calls = new Map<string, { name: string; input: unknown }>();

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    for (const part of entry.message.content) {
      const call = record(part);
      if (
        call?.type === "toolCall" &&
        typeof call.id === "string" &&
        typeof call.name === "string"
      ) {
        calls.set(call.id, { name: call.name, input: call.arguments });
      }
    }
  }

  return calls;
}

export function restoreScrapeCache(
  cache: ScrapeCache,
  entries: readonly SessionEntry[],
) {
  const calls = webToolCalls(entries);

  for (const entry of entries) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.isError
    ) {
      continue;
    }
    const call = calls.get(entry.message.toolCallId);
    if (!call) continue;
    seedFirecrawlResult(cache, call.name, call.input, entry.message.details);
  }

  return cache.size;
}

export function registerScrapeCacheRestoration(
  pi: Pick<ExtensionAPI, "on">,
  cache: ScrapeCache,
) {
  pi.on("session_start", (_event, ctx) => {
    restoreScrapeCache(cache, ctx.sessionManager.getEntries());
  });
  pi.on("tool_result", (event) => {
    if (event.isError) return;
    seedFirecrawlResult(cache, event.toolName, event.input, event.details);
  });
}
