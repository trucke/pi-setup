import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  withHostedFallback,
  type CallHosted,
  type HostedProvider,
} from "./mcp.ts";
import { boundedOutput } from "./output.ts";
import { webRenderers } from "./render.ts";
import {
  normalizeSearchResults,
  SEARCH_EXCERPT_CHARACTERS,
} from "./search-results.ts";
import { WEB_ROUTING_GUIDELINES } from "./prompt.ts";

const RECENCY = {
  hour: { hours: 1, tbs: "qdr:h" },
  day: { hours: 24, tbs: "qdr:d" },
  week: { hours: 168, tbs: "qdr:w" },
  month: { hours: 720, tbs: "qdr:m" },
  year: { hours: 8760, tbs: "qdr:y" },
} as const;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
interface SearchOptions {
  query: string;
  objective?: string;
  limit?: number;
  provider?: HostedProvider;
  includeDomains?: string[];
  excludeDomains?: string[];
  recency?: keyof typeof RECENCY;
}

export async function searchHosted(
  call: CallHosted,
  params: SearchOptions,
  signal: AbortSignal = new AbortController().signal,
) {
  const limit = params.limit ?? 5;
  if (
    !params.query.trim() ||
    params.query.length > 4096 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  )
    throw new Error(
      "Search requires a non-empty query (maximum 4096 characters) and limit between 1 and 10.",
    );
  if (
    params.objective !== undefined &&
    (!params.objective.trim() || params.objective.length > 4096)
  )
    throw new Error("Search objective must contain 1 to 4096 characters.");
  if (params.includeDomains?.length && params.excludeDomains?.length)
    throw new Error(
      "includeDomains and excludeDomains are mutually exclusive.",
    );
  for (const domains of [params.includeDomains, params.excludeDomains]) {
    if (
      domains &&
      (domains.length > 20 ||
        domains.some((domain) => domain.length > 253 || !HOSTNAME.test(domain)))
    )
      throw new Error(
        "Domain filters require at most 20 lowercase hostnames, without protocol or path.",
      );
  }
  const recency = params.recency ? RECENCY[params.recency] : undefined;
  if (params.recency && !recency) throw new Error("Invalid recency filter.");
  const filters = {
    ...(params.includeDomains?.length
      ? { includeDomains: params.includeDomains }
      : {}),
    ...(params.excludeDomains?.length
      ? { excludeDomains: params.excludeDomains }
      : {}),
  };
  const advanced = Boolean(Object.keys(filters).length || recency);
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const queryWithObjective = params.objective
    ? `${params.query}\n${params.objective}`
    : params.query;
  return withHostedFallback(
    (provider) =>
      call({
        provider,
        tool:
          provider === "exa"
            ? advanced
              ? "web_search_advanced_exa"
              : "web_search_exa"
            : "firecrawl_search",
        args:
          provider === "exa"
            ? advanced
              ? {
                  query: queryWithObjective,
                  numResults: limit,
                  ...filters,
                  ...(recency
                    ? {
                        startPublishedDate: new Date(
                          Date.now() - recency.hours * 3_600_000,
                        ).toISOString(),
                      }
                    : {}),
                  enableHighlights: true,
                  highlightsMaxCharacters: SEARCH_EXCERPT_CHARACTERS,
                  textMaxCharacters: SEARCH_EXCERPT_CHARACTERS,
                }
              : {
                  query: params.query,
                  objective: params.objective ?? params.query,
                  numResults: limit,
                }
            : {
                query: queryWithObjective,
                limit,
                ...filters,
                ...(recency ? { tbs: recency.tbs } : {}),
                highlights: true,
              },
        signal: combined,
      }),
    combined,
    params.provider,
  );
}

export function registerSearchTool(pi: ExtensionAPI, call: CallHosted) {
  const domains = Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
      maxItems: 20,
      description:
        "Lowercase hostnames, without protocol or path. includeDomains and excludeDomains are mutually exclusive.",
    }),
  );
  pi.registerTool({
    name: "web-search",
    label: "Search Web",
    ...webRenderers("web-search"),
    description:
      "Search the web through anonymous hosted MCP: Exa first, Firecrawl only on transient failures, rate limits or unavailable pages. Returns titles, source URLs, dates and excerpts of up to 1200 characters per result, not full pages or a synthesized answer. Authentication, billing, validation and cancellation failures never trigger fallback; empty results are valid. Inline output is limited to 16KB or 400 lines; use read on the saved file for more.",
    promptSnippet:
      "Discover URLs and relevant excerpts through anonymous Exa MCP, with limited Firecrawl fallback.",
    promptGuidelines: WEB_ROUTING_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "Describe the ideal page or information to find.",
      }),
      objective: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4096,
          description:
            "Specific facts to extract or documents to prioritize. Defaults to the query.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: "Maximum results. Default 5.",
        }),
      ),
      includeDomains: domains,
      excludeDomains: domains,
      recency: Type.Optional(
        StringEnum(["hour", "day", "week", "month", "year"] as const, {
          description:
            "Restrict by publication recency. Provider date precision may differ.",
        }),
      ),
      provider: Type.Optional(
        StringEnum(["exa", "firecrawl"] as const, {
          description:
            "Explicit provider for a targeted retry; disables automatic fallback.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const result = await searchHosted(call, params, signal);
      const { text, ...details } = result;
      const normalized = normalizeSearchResults(text, params.limit ?? 5);
      const output = await boundedOutput(
        `Provider: ${result.provider} (anonymous MCP)${result.fallbackReason ? `\nFallback: ${result.fallbackReason}` : ""}\n\n${normalized.resultCount !== undefined ? `Results: ${normalized.resultCount}\n\n` : ""}${normalized.text}`,
        "web-search",
      );
      return {
        content: [{ type: "text", text: output.text }],
        details: {
          ...details,
          resultCount: normalized.resultCount,
          items: normalized.items,
          ...output.details,
        },
      };
    },
  });
}
