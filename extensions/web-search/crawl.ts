import { StringEnum } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  crawlEffect,
  runFirecrawl,
  type FirecrawlProvider,
} from "./firecrawl.ts";
import { errorResult, expandHint, resultText } from "./output.ts";
import {
  CRAWL_PARAMETER_DESCRIPTIONS,
  CRAWL_PROMPT_GUIDELINES,
  CRAWL_PROMPT_SNIPPET,
  CRAWL_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  crawlMarkdown,
  crawlResultText,
  crawlView,
  displayUrl,
} from "./render.ts";
import { sanitizeLine } from "./sanitize.ts";

const DEFAULT_CRAWL_LIMIT = 5;

const CRAWL_RETRY_HINT =
  "Retry web-crawl with a smaller scope, or use web-fetch for single pages.";

export interface CrawlToolDependencies {
  getFirecrawl: FirecrawlProvider;
}

export function registerCrawlTool(
  pi: ExtensionAPI,
  { getFirecrawl }: CrawlToolDependencies,
) {
  pi.registerTool({
    name: "web-crawl",
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
        getFirecrawl,
        "crawl",
        `Crawling up to ${params.limit ?? DEFAULT_CRAWL_LIMIT} pages from: ${sanitizeLine(params.url)}`,
        ((params.timeout ?? 120) + 5) * 1_000,
        CRAWL_RETRY_HINT,
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
      let text = theme.fg("toolTitle", theme.bold("web-crawl"));
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
      if (context.isError) {
        return errorResult(result, theme, "Web crawl failed");
      }

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
}
