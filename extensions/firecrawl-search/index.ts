import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  keyHint,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import {
  Firecrawl,
  type CrawlJob,
  type CrawlOptions,
  type Document,
} from "firecrawl";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CRAWL_PARAMETER_DESCRIPTIONS,
  CRAWL_PROMPT_GUIDELINES,
  CRAWL_PROMPT_SNIPPET,
  CRAWL_TOOL_DESCRIPTION,
  SCRAPE_PARAMETER_DESCRIPTIONS,
  SCRAPE_PROMPT_GUIDELINES,
  SCRAPE_PROMPT_SNIPPET,
  SCRAPE_TOOL_DESCRIPTION,
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_GUIDELINES,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  boundedMarkdown,
  crawlMarkdown,
  crawlResultText,
  crawlView,
  displayUrl,
  documentView,
  searchItems,
  searchResultText,
  type DocumentView,
} from "./render.ts";

const DEFAULT_CRAWL_LIMIT = 5;

interface ScrapeRequest {
  url: string;
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
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

function readEnvFileValue(
  name: string,
  envPath = join(homedir(), ".pi", "agent", ".env"),
) {
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

class MissingApiKeyError extends Data.TaggedError("MissingApiKeyError")<{
  readonly message: string;
}> {}

type CommandExecutor = Pick<ExtensionAPI, "exec">;

interface ApiKeyOptions {
  env?: NodeJS.ProcessEnv;
  envPath?: string;
}

export async function resolveApiKey(
  pi: CommandExecutor,
  signal?: AbortSignal,
  options: ApiKeyOptions = {},
) {
  const processApiKey = (options.env ?? process.env).FIRECRAWL_API_KEY?.trim();
  if (processApiKey) return processApiKey;

  try {
    const result = await pi.exec(
      "infisical",
      ["secrets", "get", "FIRECRAWL_API_KEY", "--plain", "--silent"],
      {
        cwd: join(homedir(), ".pi", "agent"),
        signal,
        timeout: 15_000,
      },
    );
    const infisicalApiKey = result.code === 0 ? result.stdout.trim() : "";
    if (infisicalApiKey) return infisicalApiKey;
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  const fileApiKey = readEnvFileValue("FIRECRAWL_API_KEY", options.envPath);
  if (fileApiKey) return fileApiKey;

  throw new MissingApiKeyError({
    message:
      "Missing FIRECRAWL_API_KEY in the process environment, Infisical, or ~/.pi/agent/.env",
  });
}

function createClient(pi: CommandExecutor) {
  return Effect.tryPromise({
    try: async (signal) =>
      new Firecrawl({ apiKey: await resolveApiKey(pi, signal) }),
    catch: (cause) =>
      cause instanceof MissingApiKeyError
        ? cause
        : new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class FirecrawlError extends Data.TaggedError("FirecrawlError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function firecrawlRequest<T>(request: () => Promise<T>) {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function formatOutput(value: unknown, operation: string) {
  return Effect.tryPromise({
    try: async () => {
      const output = typeof value === "string" ? value : stringify(value);
      const truncation = truncateHead(output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      if (!truncation.truncated) return output;

      const outputDirectory = await mkdtemp(join(tmpdir(), "pi-firecrawl-"));
      const outputPath = join(outputDirectory, `${operation}.json`);
      await writeFile(outputPath, output, "utf8");

      return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
    },
    catch: (cause) => new OutputError({ message: errorMessage(cause), cause }),
  });
}

interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

function resultText(result: RenderableResult) {
  return result.content.find(
    (item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string",
  )?.text;
}

function expandHint(theme: Theme) {
  return theme.fg("dim", keyHint("app.tools.expand", "to expand"));
}

function errorResult(result: RenderableResult, theme: Theme) {
  return new Text(
    theme.fg("error", resultText(result)?.trim() || "Firecrawl request failed"),
    0,
    0,
  );
}

function documentSummary(document: DocumentView) {
  const parts = [document.title];
  if (document.statusCode !== undefined) {
    parts.push(`HTTP ${document.statusCode}`);
  }
  if (document.creditsUsed !== undefined) {
    parts.push(
      `${document.creditsUsed} credit${document.creditsUsed === 1 ? "" : "s"}`,
    );
  }
  if (document.markdown) {
    parts.push(formatSize(Buffer.byteLength(document.markdown, "utf8")));
  }
  return parts.join(" · ");
}

function expandedDocument(
  document: DocumentView,
  summary: string,
  theme: Theme,
) {
  const container = new Container();
  container.addChild(new Text(theme.fg("success", `✓ ${summary}`), 0, 0));
  if (document.url) {
    container.addChild(
      new Text(theme.fg("dim", `Source: ${document.url}`), 0, 0),
    );
  }
  if (document.description) {
    container.addChild(new Text(theme.fg("muted", document.description), 0, 0));
  }

  if (!document.markdown) {
    container.addChild(
      new Text(theme.fg("dim", "No Markdown content returned."), 0, 0),
    );
    return container;
  }

  const bounded = boundedMarkdown(document.markdown);
  container.addChild(new Markdown(bounded.content, 0, 0, getMarkdownTheme()));
  if (bounded.truncated) {
    container.addChild(
      new Text(
        theme.fg(
          "warning",
          `Preview truncated to ${bounded.outputLines} of ${bounded.totalLines} lines.`,
        ),
        0,
        0,
      ),
    );
  }
  return container;
}

export type CrawlClient = Pick<
  Firecrawl,
  "startCrawl" | "getCrawlStatus" | "cancelCrawl"
>;

function pollCrawl(
  client: CrawlClient,
  jobId: string,
): Effect.Effect<CrawlJob, FirecrawlError> {
  return firecrawlRequest(() => client.getCrawlStatus(jobId)).pipe(
    Effect.flatMap((job) =>
      job.status === "scraping"
        ? Effect.sleep("2 seconds").pipe(
            Effect.flatMap(() =>
              Effect.suspend(() => pollCrawl(client, jobId)),
            ),
          )
        : Effect.succeed(job),
    ),
  );
}

/** Brackets the remote job so every non-successful exit attempts cancellation. */
export function crawlEffect(
  client: CrawlClient,
  url: string,
  options: CrawlOptions,
) {
  return Effect.acquireUseRelease(
    firecrawlRequest(() => client.startCrawl(url, options)),
    (job) => pollCrawl(client, job.id),
    (job, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : firecrawlRequest(() => client.cancelCrawl(job.id)).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          ),
  );
}

function operationError(operation: string, error: unknown) {
  if (error instanceof MissingApiKeyError) return new Error(error.message);

  const cause =
    error instanceof FirecrawlError || error instanceof OutputError
      ? error.cause
      : error;
  return new Error(`Firecrawl ${operation} failed: ${errorMessage(error)}`, {
    cause,
  });
}

/** Shared Effect pipeline with a single Promise boundary for the tool API. */
async function runFirecrawl<T>(
  pi: CommandExecutor,
  operation: string,
  status: string,
  timeout: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<T | undefined> | undefined,
  request: (
    client: Firecrawl,
  ) => Effect.Effect<
    { details: T; output: unknown },
    FirecrawlError | OutputError
  >,
) {
  const program = Effect.gen(function* () {
    const client = yield* createClient(pi);
    yield* Effect.sync(() =>
      onUpdate?.({
        content: [{ type: "text", text: status }],
        details: undefined,
      }),
    );

    const { details, output } = yield* request(client).pipe(
      Effect.timeout(timeout),
    );
    const formatted = yield* formatOutput(output, operation);

    return {
      content: [{ type: "text" as const, text: formatted }],
      details,
    } satisfies AgentToolResult<T | undefined>;
  });

  const exit = await Effect.runPromiseExit(
    program,
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("Firecrawl request cancelled");
  }
  throw operationError(operation, Cause.squash(exit.cause));
}

export default function firecrawlTools(pi: ExtensionAPI) {
  const scrapeCache = new Map<string, Promise<Document>>();

  pi.registerTool({
    name: "firecrawl_search",
    label: "Search Web",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: SEARCH_PARAMETER_DESCRIPTIONS.query,
      }),
      limit: Type.Optional(
        Type.Number({
          description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 10,
        }),
      ),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        pi,
        "search",
        `Searching Firecrawl for: ${params.query}`,
        35_000,
        signal,
        onUpdate,
        (client) =>
          firecrawlRequest(() =>
            client.search(params.query, {
              limit: params.limit ?? 5,
              sources: [params.source ?? "web"],
              highlights: false,
              timeout: 30_000,
            }),
          ).pipe(
            Effect.map((result) => ({
              details: result,
              output: searchResultText(result),
            })),
          ),
      ),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("firecrawl_search"));
      text += ` ${theme.fg("accent", `“${args.query}”`)}`;
      text += theme.fg(
        "muted",
        ` · ${args.source ?? "web"} · limit ${args.limit ?? 5}`,
      );
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", resultText(result)?.trim() || "Searching…"),
          0,
          0,
        );
      }
      if (context.isError) return errorResult(result, theme);

      const items = searchItems(result.details);
      if (items.length === 0) {
        return new Text(theme.fg("dim", "No search results"), 0, 0);
      }

      const kinds = [...new Set(items.map((item) => item.kind))].join("/");
      let text = theme.fg(
        "success",
        `✓ ${items.length} ${kinds} result${items.length === 1 ? "" : "s"}`,
      );
      const visible = expanded ? items : items.slice(0, 3);
      for (const [index, item] of visible.entries()) {
        text += `\n${theme.fg("accent", `${index + 1}. ${item.title}`)}`;
        if (item.url) {
          text += theme.fg("dim", ` — ${displayUrl(item.url)}`);
        }
        if (expanded && item.description) {
          text += `\n   ${theme.fg("muted", item.description)}`;
        }
        if (expanded && item.url) {
          text += `\n   ${theme.fg("dim", item.url)}`;
        }
      }
      if (!expanded && items.length > visible.length) {
        text += `\n${theme.fg("dim", `… ${items.length - visible.length} more`)}`;
      }
      if (!expanded) text += `\n${expandHint(theme)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "firecrawl_crawl",
    label: "Crawl Website",
    description: CRAWL_TOOL_DESCRIPTION,
    promptSnippet: CRAWL_PROMPT_SNIPPET,
    promptGuidelines: CRAWL_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: CRAWL_PARAMETER_DESCRIPTIONS.url }),
      limit: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 100,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.maxDiscoveryDepth,
          minimum: 0,
        }),
      ),
      includePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.includePaths,
        }),
      ),
      excludePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.excludePaths,
        }),
      ),
      crawlEntireDomain: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.crawlEntireDomain,
        }),
      ),
      allowSubdomains: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.allowSubdomains,
        }),
      ),
      sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const)),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 600,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        pi,
        "crawl",
        `Crawling up to ${params.limit ?? DEFAULT_CRAWL_LIMIT} pages from: ${params.url}`,
        ((params.timeout ?? 120) + 5) * 1_000,
        signal,
        onUpdate,
        (client) =>
          crawlEffect(client, params.url, {
            limit: params.limit ?? DEFAULT_CRAWL_LIMIT,
            maxDiscoveryDepth: params.maxDiscoveryDepth,
            includePaths: params.includePaths,
            excludePaths: params.excludePaths,
            crawlEntireDomain: params.crawlEntireDomain,
            allowSubdomains: params.allowSubdomains,
            sitemap: params.sitemap,
            scrapeOptions: {
              formats: ["markdown"],
              onlyMainContent: params.onlyMainContent ?? true,
            },
          }).pipe(
            Effect.map((result) => ({
              details: result,
              output: crawlResultText(result),
            })),
          ),
      ),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("firecrawl_crawl"));
      text += ` ${theme.fg("accent", displayUrl(args.url))}`;
      text += theme.fg(
        "muted",
        ` · limit ${args.limit ?? DEFAULT_CRAWL_LIMIT}`,
      );
      if (args.maxDiscoveryDepth !== undefined) {
        text += theme.fg("dim", ` · depth ${args.maxDiscoveryDepth}`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", resultText(result)?.trim() || "Crawling…"),
          0,
          0,
        );
      }
      if (context.isError) return errorResult(result, theme);

      const crawl = crawlView(result.details);
      const credits =
        crawl.creditsUsed === undefined
          ? ""
          : ` · ${crawl.creditsUsed} credit${crawl.creditsUsed === 1 ? "" : "s"}`;
      const statusColor =
        crawl.status === "completed"
          ? "success"
          : crawl.status === "failed"
            ? "error"
            : "warning";
      const summary = `${crawl.status} · ${crawl.completed}/${crawl.total} pages${credits}`;

      if (!expanded) {
        let text = theme.fg(
          statusColor,
          `${crawl.status === "completed" ? "✓ " : ""}${summary}`,
        );
        const visible = crawl.documents.slice(0, 3);
        for (const [index, document] of visible.entries()) {
          text += `\n${theme.fg("accent", `${index + 1}. ${document.title}`)}`;
          if (document.url) {
            text += theme.fg("dim", ` — ${displayUrl(document.url)}`);
          }
        }
        if (crawl.documents.length > visible.length) {
          text += `\n${theme.fg("dim", `… ${crawl.documents.length - visible.length} more`)}`;
        }
        text += `\n${expandHint(theme)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(theme.fg(statusColor, summary), 0, 0));
      if (crawl.id) {
        container.addChild(
          new Text(theme.fg("dim", `Crawl ID: ${crawl.id}`), 0, 0),
        );
      }
      if (crawl.documents.length === 0) {
        container.addChild(
          new Text(theme.fg("dim", "No pages returned."), 0, 0),
        );
        return container;
      }

      const markdown = crawlMarkdown(crawl.documents);
      container.addChild(
        new Markdown(markdown.content, 0, 0, getMarkdownTheme()),
      );
      if (markdown.truncated) {
        container.addChild(
          new Text(
            theme.fg(
              "warning",
              `Preview truncated to ${markdown.outputLines} of ${markdown.totalLines} lines.`,
            ),
            0,
            0,
          ),
        );
      }
      return container;
    },
  });

  pi.registerTool({
    name: "firecrawl_scrape",
    label: "Scrape Page",
    description: SCRAPE_TOOL_DESCRIPTION,
    promptSnippet: SCRAPE_PROMPT_SNIPPET,
    promptGuidelines: SCRAPE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: SCRAPE_PARAMETER_DESCRIPTIONS.url }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.waitFor,
          minimum: 0,
          maximum: 60_000,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 120_000,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.includeMetadata,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        pi,
        "scrape",
        `Scraping page with Firecrawl: ${params.url}`,
        (params.timeout ?? 30_000) + 5_000,
        signal,
        onUpdate,
        (client) => {
          const request = {
            url: params.url,
            onlyMainContent: params.onlyMainContent,
            waitFor: params.waitFor,
            timeout: params.timeout,
          };
          return firecrawlRequest(() =>
            memoizedRequest(scrapeCache, scrapeRequestKey(request), () =>
              client.scrape(params.url, {
                formats: ["markdown"],
                onlyMainContent: params.onlyMainContent ?? true,
                waitFor: params.waitFor,
                timeout: params.timeout ?? 30_000,
              }),
            ),
          ).pipe(
            Effect.flatMap(({ value: document, cacheHit }) =>
              Effect.try({
                try: () => {
                  const details = cacheHit
                    ? {
                        ...document,
                        metadata: { ...document.metadata, creditsUsed: 0 },
                        localCacheHit: true,
                      }
                    : document;
                  const metadata =
                    params.includeMetadata && details.metadata
                      ? `\n\nMetadata:\n${stringify(details.metadata)}`
                      : "";
                  const markdown =
                    document.markdown?.trim() ||
                    "No markdown content returned.";
                  const cacheNotice = cacheHit
                    ? "[Reused cached scrape; no Firecrawl request was made.]\n\n"
                    : "";

                  return {
                    details,
                    output: `${cacheNotice}${markdown}${metadata}`,
                  };
                },
                catch: (cause) =>
                  new OutputError({ message: errorMessage(cause), cause }),
              }),
            ),
          );
        },
      ),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("firecrawl_scrape"));
      text += ` ${theme.fg("accent", displayUrl(args.url))}`;
      if (args.onlyMainContent === false) {
        text += theme.fg("muted", " · full page");
      }
      if (args.includeMetadata) {
        text += theme.fg("dim", " · metadata");
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", resultText(result)?.trim() || "Scraping…"),
          0,
          0,
        );
      }
      if (context.isError) return errorResult(result, theme);

      const document = documentView(result.details);
      const summary = documentSummary(document);
      if (expanded) return expandedDocument(document, summary, theme);

      let text = theme.fg("success", `✓ ${summary}`);
      if (document.url) {
        text += `\n${theme.fg("dim", displayUrl(document.url))}`;
      }
      if (document.description) {
        text += `\n${theme.fg("muted", document.description)}`;
      }
      text += `\n${expandHint(theme)}`;
      return new Text(text, 0, 0);
    },
  });
}
