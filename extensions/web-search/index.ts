/**
 * web-search - Consolidated, capability-oriented web tooling.
 *
 * Public tools:
 * - web-research: one-shot Codex CLI session with live web search; returns a
 *   concise, cited Markdown answer.
 * - web-search: discovery search. Default backend exa (direct Exa Search
 *   API, cheap); backend "firecrawl" for structured web/news/image results.
 * - web-fetch: read one known URL. Default backend exa (direct Exa Contents
 *   API); backend "firecrawl" for robust browser-rendered scraping.
 * - web-crawl: multi-page Firecrawl crawl of one website.
 *
 * Backends never fall back to each other silently; errors name the explicit
 * retry. Provider initialization is lazy so a missing credential for one
 * backend cannot break extension loading. Firecrawl calls are credit-budgeted
 * per session and surfaced on the dashboard; Exa-backed defaults never
 * reserve Firecrawl credits. Firecrawl scrapes are reused across reloads and
 * resumes, including results persisted under the legacy tool names
 * codex_research/firecrawl_search/firecrawl_scrape/firecrawl_crawl.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerScrapeCacheRestoration, type ScrapeCache } from "./cache.ts";
import { registerCrawlTool } from "./crawl.ts";
import { createExaKeyProvider } from "./exa.ts";
import { registerFetchTool } from "./fetch.ts";
import { createFirecrawlProvider } from "./firecrawl.ts";
import { registerResearchTool } from "./research.ts";
import { registerSearchTool } from "./search.ts";
import { registerUsageTracking } from "./usage.ts";

export default function webSearch(pi: ExtensionAPI) {
  const scrapeCache: ScrapeCache = new Map();
  const getFirecrawl = createFirecrawlProvider();
  const getExaKey = createExaKeyProvider();

  registerScrapeCacheRestoration(pi, scrapeCache);
  registerUsageTracking(pi);

  registerResearchTool(pi);
  registerSearchTool(pi, { getFirecrawl, getExaKey });
  registerFetchTool(pi, { getFirecrawl, getExaKey, scrapeCache });
  registerCrawlTool(pi, { getFirecrawl });
}
