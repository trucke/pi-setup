import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  exaSearch,
  type ExaKeyProvider,
  type ExaTransport,
  type RecencyFilter,
} from "./exa.ts";
import {
  FIRECRAWL_SEARCH_TIMEOUT_MS,
  firecrawlRequest,
  runFirecrawl,
  type FirecrawlProvider,
} from "./firecrawl.ts";
import {
  boundedOutput,
  errorResult,
  expandHint,
  resultText,
} from "./output.ts";
import {
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
  WEB_ROUTING_GUIDELINES,
} from "./prompt.ts";
import {
  displayUrl,
  searchItems,
  searchResultText,
  summaryLine,
} from "./render.ts";
import { sanitizeLine } from "./sanitize.ts";

const DEFAULT_SEARCH_LIMIT = 5;

const EXA_RETRY_HINT =
  'Retry web-search, or escalate explicitly with backend: "firecrawl".';
const FIRECRAWL_RETRY_HINT =
  'Retry web-search with backend: "firecrawl", configure FIRECRAWL_API_KEY for higher limits, or use the default exa backend.';

/** Maps the friendly recency filter to Firecrawl's Google-style `tbs` values. */
const RECENCY_TBS: Record<RecencyFilter, string> = {
  hour: "qdr:h",
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export interface SearchToolDependencies {
  getFirecrawl: FirecrawlProvider;
  getExaKey: ExaKeyProvider;
  transport?: ExaTransport;
}

export function registerSearchTool(
  pi: ExtensionAPI,
  { getFirecrawl, getExaKey, transport }: SearchToolDependencies,
) {
  pi.registerTool({
    name: "web-search",
    label: "Search Web",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: WEB_ROUTING_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: SEARCH_PARAMETER_DESCRIPTIONS.query,
      }),
      backend: Type.Optional(
        StringEnum(["exa", "firecrawl"] as const, {
          description: SEARCH_PARAMETER_DESCRIPTIONS.backend,
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 10,
        }),
      ),
      source: Type.Optional(
        StringEnum(["web", "news", "images"] as const, {
          description: SEARCH_PARAMETER_DESCRIPTIONS.source,
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: SEARCH_PARAMETER_DESCRIPTIONS.includeDomains,
        }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: SEARCH_PARAMETER_DESCRIPTIONS.excludeDomains,
        }),
      ),
      recency: Type.Optional(
        StringEnum(["hour", "day", "week", "month", "year"] as const, {
          description: SEARCH_PARAMETER_DESCRIPTIONS.recency,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      if (params.includeDomains?.length && params.excludeDomains?.length) {
        throw new Error(
          "web-search cannot combine includeDomains and excludeDomains",
        );
      }

      const backend = params.backend ?? "exa";
      const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;

      if (backend === "exa") {
        if (params.source && params.source !== "web") {
          throw new Error(
            `The exa backend has no structured "${params.source}" source. Retry web-search with backend: "firecrawl".`,
          );
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Searching Exa for: ${sanitizeLine(params.query)}`,
            },
          ],
          details: undefined,
        });

        const details = await exaSearch(
          getExaKey,
          {
            query: params.query,
            limit,
            includeDomains: params.includeDomains,
            excludeDomains: params.excludeDomains,
            recency: params.recency,
          },
          EXA_RETRY_HINT,
          signal,
          transport,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: await boundedOutput(searchResultText(details), "search"),
            },
          ],
          details,
        };
      }

      return runFirecrawl(
        getFirecrawl,
        "search",
        `Searching Firecrawl for: ${sanitizeLine(params.query)}`,
        FIRECRAWL_SEARCH_TIMEOUT_MS + 5_000,
        FIRECRAWL_RETRY_HINT,
        signal,
        onUpdate,
        (client) =>
          firecrawlRequest(() =>
            client.search(params.query, {
              limit,
              sources: [params.source ?? "web"],
              includeDomains: params.includeDomains,
              excludeDomains: params.excludeDomains,
              tbs: params.recency ? RECENCY_TBS[params.recency] : undefined,
              // Explicit so query-relevant excerpts survive an upstream
              // default change.
              highlights: true,
              timeout: FIRECRAWL_SEARCH_TIMEOUT_MS,
            }),
          ).pipe(
            Effect.map((result) => ({
              details: result,
              output: searchResultText(result),
            })),
          ),
      );
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web-search"));
      text += ` ${theme.fg("accent", `“${sanitizeLine(args.query)}”`)}`;
      text += theme.fg(
        "muted",
        ` · ${args.backend ?? "exa"} · limit ${args.limit ?? DEFAULT_SEARCH_LIMIT}`,
      );
      if (args.source && args.source !== "web") {
        text += theme.fg("muted", ` · ${args.source}`);
      }
      if (args.recency) {
        text += theme.fg("muted", ` · past ${args.recency}`);
      }
      if (args.includeDomains?.length) {
        text += theme.fg(
          "muted",
          ` · on ${args.includeDomains.map(sanitizeLine).join(", ")}`,
        );
      }
      if (args.excludeDomains?.length) {
        text += theme.fg(
          "muted",
          ` · not ${args.excludeDomains.map(sanitizeLine).join(", ")}`,
        );
      }
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
      if (context.isError) {
        return errorResult(result, theme, "Web search failed");
      }

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
          text += `\n   ${theme.fg("muted", summaryLine(item.description))}`;
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
}
