import { StringEnum } from "@earendil-works/pi-ai";
import {
  formatSize,
  getMarkdownTheme,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  memoizedRequest,
  scrapeRequestKey,
  type ScrapeCache,
} from "./cache.ts";
import {
  exaFetch,
  type ExaFetchDetails,
  type ExaKeyProvider,
  type ExaTransport,
} from "./exa.ts";
import {
  firecrawlOutputError,
  firecrawlRequest,
  runFirecrawl,
  type FirecrawlProvider,
} from "./firecrawl.ts";
import {
  boundedOutput,
  errorResult,
  expandHint,
  resultText,
  stringify,
} from "./output.ts";
import {
  FETCH_PARAMETER_DESCRIPTIONS,
  FETCH_PROMPT_GUIDELINES,
  FETCH_PROMPT_SNIPPET,
  FETCH_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  boundedMarkdown,
  displayUrl,
  documentView,
  type DocumentView,
} from "./render.ts";
import { parsePublicHttpUrl } from "../shared/public-url.ts";
import { sanitizeLine } from "./sanitize.ts";

const EXA_RETRY_HINT =
  'Retry web-fetch, or escalate explicitly with backend: "firecrawl".';
const FIRECRAWL_RETRY_HINT =
  'Retry web-fetch with backend: "firecrawl", configure FIRECRAWL_API_KEY for higher limits, or use the default exa backend.';

/** Firecrawl-only scrape options that must not be silently ignored on exa. */
const FIRECRAWL_ONLY_PARAMETERS = [
  "onlyMainContent",
  "waitFor",
  "timeout",
  "includeMetadata",
] as const;

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

function exaFetchDetails(value: unknown): ExaFetchDetails | undefined {
  const details = value as ExaFetchDetails | undefined;
  return details?.backend === "exa" && Array.isArray(details.pages)
    ? details
    : undefined;
}

function exaSummary(details: ExaFetchDetails) {
  const page = details.pages[0];
  const parts = [page?.title ?? "No content"];
  if (page) parts.push(`${page.characters.toLocaleString("en-US")} chars`);
  if (details.errors.length > 0) {
    parts.push(
      `${details.errors.length} error${details.errors.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" · ");
}

export interface FetchToolDependencies {
  getFirecrawl: FirecrawlProvider;
  getExaKey: ExaKeyProvider;
  scrapeCache: ScrapeCache;
  transport?: ExaTransport;
}

export function registerFetchTool(
  pi: ExtensionAPI,
  { getFirecrawl, getExaKey, scrapeCache, transport }: FetchToolDependencies,
) {
  pi.registerTool({
    name: "web-fetch",
    label: "Fetch Page",
    description: FETCH_TOOL_DESCRIPTION,
    promptSnippet: FETCH_PROMPT_SNIPPET,
    promptGuidelines: FETCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: FETCH_PARAMETER_DESCRIPTIONS.url }),
      backend: Type.Optional(
        StringEnum(["exa", "firecrawl"] as const, {
          description: FETCH_PARAMETER_DESCRIPTIONS.backend,
        }),
      ),
      fresh: Type.Optional(
        Type.Boolean({
          description: FETCH_PARAMETER_DESCRIPTIONS.fresh,
        }),
      ),
      maxCharacters: Type.Optional(
        Type.Number({
          description: FETCH_PARAMETER_DESCRIPTIONS.maxCharacters,
          minimum: 1,
        }),
      ),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: FETCH_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description: FETCH_PARAMETER_DESCRIPTIONS.waitFor,
          minimum: 0,
          maximum: 60_000,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: FETCH_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 120_000,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description: FETCH_PARAMETER_DESCRIPTIONS.includeMetadata,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const backend = params.backend ?? "exa";
      const url = parsePublicHttpUrl(params.url, "Web URL").href;

      if (backend === "exa") {
        const unsupported = FIRECRAWL_ONLY_PARAMETERS.filter(
          (name) => params[name] !== undefined,
        );
        if (unsupported.length > 0) {
          throw new Error(
            `${unsupported.join(", ")} only appl${unsupported.length === 1 ? "ies" : "y"} to the firecrawl backend. Retry web-fetch with backend: "firecrawl" or without ${unsupported.length === 1 ? "it" : "them"}.`,
          );
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Fetching with Exa: ${sanitizeLine(url)}`,
            },
          ],
          details: undefined,
        });

        const { details, output } = await exaFetch(
          getExaKey,
          {
            url,
            maxCharacters: params.maxCharacters,
            fresh: params.fresh,
          },
          EXA_RETRY_HINT,
          signal,
          transport,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: await boundedOutput(output, "fetch"),
            },
          ],
          details,
        };
      }

      if (params.maxCharacters !== undefined) {
        throw new Error(
          "maxCharacters only applies to the exa backend. Retry web-fetch with the default exa backend or without it.",
        );
      }

      return runFirecrawl(
        getFirecrawl,
        "scrape",
        `Scraping page with Firecrawl: ${sanitizeLine(url)}`,
        (params.timeout ?? 30_000) + 5_000,
        FIRECRAWL_RETRY_HINT,
        signal,
        onUpdate,
        (client) => {
          const request = {
            url,
            onlyMainContent: params.onlyMainContent,
            waitFor: params.waitFor,
            timeout: params.timeout,
          };
          const key = scrapeRequestKey(request);
          if (params.fresh) scrapeCache.delete(key);
          return firecrawlRequest(() =>
            memoizedRequest(scrapeCache, key, () =>
              client.scrape(url, {
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
                catch: firecrawlOutputError,
              }),
            ),
          );
        },
      );
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web-fetch"));
      text += ` ${theme.fg("accent", displayUrl(args.url))}`;
      text += theme.fg("muted", ` · ${args.backend ?? "exa"}`);
      if (args.onlyMainContent === false) {
        text += theme.fg("muted", " · full page");
      }
      if (args.fresh) {
        text += theme.fg("warning", " · fresh");
      }
      if (args.includeMetadata) {
        text += theme.fg("dim", " · metadata");
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", resultText(result)?.trim() || "Fetching…"),
          0,
          0,
        );
      }
      if (context.isError) {
        return errorResult(result, theme, "Web fetch failed");
      }

      const exa = exaFetchDetails(result.details);
      if (exa) {
        const summary = exaSummary(exa);
        if (!expanded) {
          let text = theme.fg("success", `✓ ${summary}`);
          const page = exa.pages[0];
          if (page?.url) {
            text += `\n${theme.fg("dim", displayUrl(page.url))}`;
          }
          text += `\n${expandHint(theme)}`;
          return new Text(text, 0, 0);
        }

        const container = new Container();
        container.addChild(new Text(theme.fg("success", `✓ ${summary}`), 0, 0));
        // The bounded page text lives in the tool output, not in details.
        container.addChild(
          new Markdown(resultText(result) ?? "", 0, 0, getMarkdownTheme()),
        );
        return container;
      }

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
