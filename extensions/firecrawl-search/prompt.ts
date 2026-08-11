/** Describes Firecrawl search and its model-context output limits. */
export const SEARCH_TOOL_DESCRIPTION =
  "Discover web, news, or image URLs with Firecrawl. Search results include titles, descriptions, and snippets but never scraped page content. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's current-information search capability to the model's tool prompt. */
export const SEARCH_PROMPT_SNIPPET =
  "Discover web URLs with Firecrawl without scraping result pages.";

/** Guides the model on when to search and when to follow with scrape or crawl. */
export const SEARCH_PROMPT_GUIDELINES = [
  "Use firecrawl_search to discover URLs for current web information or sources beyond the local workspace; it does not scrape result pages.",
  "Use firecrawl_scrape directly instead of firecrawl_search when the relevant URL is already known.",
  "Use 3–5 firecrawl_search results for targeted research and 10 only when broader discovery is needed.",
  "Consolidate related discovery questions into one firecrawl_search query before issuing narrower follow-up searches.",
  "After firecrawl_search, use firecrawl_scrape only for the selected pages whose full content is needed.",
  "Use firecrawl_crawl when the user needs content from multiple pages of the same website.",
];

/** Model-facing schema descriptions for Firecrawl search parameters. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "The web search query.",
  limit: "Maximum number of results. Defaults to 5; maximum 10.",
};

/** Describes multi-page Firecrawl crawling and its page and output limits. */
export const CRAWL_TOOL_DESCRIPTION =
  "Crawl multiple pages of a website with Firecrawl and return markdown documents. Defaults to 5 pages and never accepts a limit above 100. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's multi-page crawl capability to the model's tool prompt. */
export const CRAWL_PROMPT_SNIPPET =
  "Crawl multiple pages of a website with Firecrawl.";

/** Guides the model to use focused crawl limits and prefer scrape for one URL. */
export const CRAWL_PROMPT_GUIDELINES = [
  "Use firecrawl_crawl when the user needs content from multiple related pages on one website.",
  "Start firecrawl_crawl with a limit of 5 or lower and expand only when the initial results are insufficient.",
  "Restrict firecrawl_crawl with includePaths, excludePaths, and maxDiscoveryDepth whenever the scope is known.",
  "Use firecrawl_scrape instead of firecrawl_crawl when only one known URL is needed.",
];

/** Model-facing schema descriptions for Firecrawl crawl parameters. */
export const CRAWL_PARAMETER_DESCRIPTIONS = {
  url: "The starting URL to crawl.",
  limit:
    "Maximum pages to crawl. Defaults to 5; maximum 100. Each page consumes a Firecrawl credit.",
  maxDiscoveryDepth: "Maximum link-discovery depth from the starting URL.",
  includePaths: "URL pathname regex patterns to include.",
  excludePaths: "URL pathname regex patterns to exclude.",
  crawlEntireDomain: "Allow sibling and parent paths on the same domain.",
  allowSubdomains: "Allow crawling subdomains.",
  onlyMainContent: "Extract only each page's main content. Defaults to true.",
  timeout: "Maximum crawl wait time in seconds. Defaults to 120.",
};

/** Describes single-page Firecrawl scraping and its model-context output limits. */
export const SCRAPE_TOOL_DESCRIPTION =
  "Scrape one page with Firecrawl and return markdown. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's readable single-page fetch capability to the model's tool prompt. */
export const SCRAPE_PROMPT_SNIPPET =
  "Fetch one URL as readable markdown with Firecrawl.";

/** Guides the model to use scrape for one known page and crawl for multiple pages. */
export const SCRAPE_PROMPT_GUIDELINES = [
  "Use firecrawl_scrape when you need the full readable markdown content of one known URL.",
  "Do not call firecrawl_scrape again when equivalent page content is already available in the conversation unless the user needs a fresh copy.",
  "Prefer firecrawl_scrape over bash or raw HTTP fetching for web pages because it returns cleaned content.",
  "Use firecrawl_crawl instead when content is needed from multiple pages on the same website.",
];

/** Model-facing schema descriptions for Firecrawl scrape parameters. */
export const SCRAPE_PARAMETER_DESCRIPTIONS = {
  url: "The URL to scrape.",
  onlyMainContent: "Return only the main page content. Defaults to true.",
  waitFor:
    "Milliseconds to wait before capture, useful for JavaScript-heavy pages.",
  timeout: "Request timeout in milliseconds. Defaults to 30000.",
  fresh: "Bypass session reuse and scrape a fresh copy. Defaults to false.",
  includeMetadata:
    "Append page metadata to the markdown. Defaults to false; metadata remains available in tool details.",
};
