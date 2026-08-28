import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveOptionalApiKey, type ApiKeyOptions } from "./env.ts";
import {
  boundedOutput,
  errorMessage,
  errorResult,
  expandHint,
  resultText,
} from "./output.ts";
import {
  DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS,
  DEVELOPER_SEARCH_PROMPT_GUIDELINES,
  DEVELOPER_SEARCH_PROMPT_SNIPPET,
  DEVELOPER_SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { displayUrl, summaryLine } from "./render.ts";
import { sanitizeLine, sanitizeText } from "./sanitize.ts";

export const DEVELOPER_SEARCH_URL =
  "https://api.firecrawl.dev/v2/search/developer";
export const DEVELOPER_SEARCH_TIMEOUT_MS = 60_000;

export const DEFAULT_DEVELOPER_SEARCH_LIMIT = 10;
/** Upstream `k` allows 100; 20 keeps one call within the session budget scale. */
export const MAX_DEVELOPER_SEARCH_LIMIT = 20;
const MAX_PASSAGES_PER_RESULT = 5;

/** Bounds persisted evidence even if the upstream response exceeds the request. */
const MAX_PASSAGE_CHARS = 2_000;

const RETRY_HINT =
  "Retry developer-search with a narrower scope, configure FIRECRAWL_API_KEY for higher rate limits, or use web-search for general web results.";

export const DEVELOPER_RESULT_TYPES = [
  "doc",
  "issue",
  "pull_request",
  "readme",
] as const;
export type DeveloperResultType = (typeof DEVELOPER_RESULT_TYPES)[number];
const REPOSITORY_RESULT_TYPES = ["issue", "pull_request", "readme"] as const;

/**
 * Loosely-typed Developer Index response. Every field is re-validated during
 * normalization, so one code path serves live responses and session details
 * restored from disk.
 */
interface DeveloperApiResponse {
  results?: unknown;
  coverage?: unknown;
  reranked?: unknown;
  repos?: unknown;
  sources?: unknown;
}

/** Normalized, sanitized, persisted developer-search details. */
export interface DeveloperSearchItem {
  id: string;
  type: string;
  /** Docs often arrive without titles; falls back to the URL. */
  title: string;
  url: string;
  passages: string[];
}

export interface DeveloperSearchDetails {
  backend: "firecrawl";
  results: DeveloperSearchItem[];
  coverage: Record<DeveloperResultType, string>;
  reranked: boolean;
  repos?: Array<{
    repo: string;
    indexed: boolean;
    types?: { issue: boolean; pullRequest: boolean; readme: boolean };
  }>;
  sources?: Array<{ source: string; indexed: boolean }>;
}

export interface DeveloperSearchOptions {
  query: string;
  limit: number;
  types?: DeveloperResultType[];
  repos?: string[];
  sources?: string[];
  passages?: number;
}

/**
 * Builds the Developer Index request. The model-facing `limit` maps to
 * upstream `k`, capped at 20 to keep one call within the session budget scale.
 * Optional filters are omitted so upstream defaults (all types, one passage)
 * stay authoritative.
 */
export function buildDeveloperSearchRequest(options: DeveloperSearchOptions) {
  if (options.types?.length) {
    const requestedTypes = new Set(options.types);
    if (
      options.repos?.length &&
      !REPOSITORY_RESULT_TYPES.some((type) => requestedTypes.has(type))
    ) {
      throw new Error(
        "developer-search repos cannot match the requested types; add issue, pull_request, or readme, or drop repos.",
      );
    }
    if (options.sources?.length && !requestedTypes.has("doc")) {
      throw new Error(
        "developer-search sources cannot match the requested types; add doc or drop sources.",
      );
    }
  }

  return {
    query: options.query,
    k: Math.min(
      Math.max(1, Math.floor(options.limit)),
      MAX_DEVELOPER_SEARCH_LIMIT,
    ),
    ...(options.types?.length ? { types: options.types } : {}),
    ...(options.repos?.length ? { repos: options.repos } : {}),
    ...(options.sources?.length ? { sources: options.sources } : {}),
    ...(options.passages !== undefined ? { passages: options.passages } : {}),
  };
}

/**
 * Memoized optional FIRECRAWL_API_KEY lookup. The endpoint is keyless; a
 * configured key is sent only for higher rate limits.
 */
export type OptionalFirecrawlKeyProvider = () => string | undefined;

export function createOptionalFirecrawlKeyProvider(
  options: ApiKeyOptions = {},
): OptionalFirecrawlKeyProvider {
  let resolved = false;
  let apiKey: string | undefined;

  return () => {
    if (!resolved) {
      apiKey = resolveOptionalApiKey("FIRECRAWL_API_KEY", options);
      resolved = true;
    }
    return apiKey;
  };
}

export interface DeveloperSearchTransport {
  fetch?: typeof fetch;
  /** Test-only override of the request timeout. */
  timeoutMs?: number;
}

/** Typed failure; `message` is the complete model-facing error text. */
class DeveloperSearchError extends Data.TaggedError("DeveloperSearchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * One Developer Index HTTP call as an Effect, mirroring the Exa transport:
 * fiber interruption (tool cancellation) aborts the in-flight request, and
 * `AbortSignal.timeout` bounds the request including body reads. The unref'd
 * web-standard timeout avoids the Effect v4 beta timer leak on interruption.
 */
function developerSearchRequest(
  body: unknown,
  apiKey: string | undefined,
  transport: DeveloperSearchTransport,
): Effect.Effect<DeveloperApiResponse, DeveloperSearchError> {
  const doFetch = transport.fetch ?? fetch;
  const requestTimeoutMs = transport.timeoutMs ?? DEVELOPER_SEARCH_TIMEOUT_MS;

  return Effect.tryPromise({
    try: async (signal) => {
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const combined = AbortSignal.any([signal, timeout]);

      try {
        const response = await doFetch(DEVELOPER_SEARCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Keyless by default; Authorization only when a key is configured.
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: combined,
        });

        if (!response.ok) {
          const detail = sanitizeLine(
            await response.text().catch(() => ""),
          ).slice(0, 300);
          throw new DeveloperSearchError({
            message: `Firecrawl developer search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}. ${RETRY_HINT}`,
          });
        }

        try {
          return (await response.json()) as DeveloperApiResponse;
        } catch (error) {
          throw new DeveloperSearchError({
            message: `Firecrawl developer search returned invalid JSON: ${errorMessage(error)}. ${RETRY_HINT}`,
            cause: error,
          });
        }
      } catch (error) {
        if (
          !(error instanceof DeveloperSearchError) &&
          timeout.aborted &&
          !signal.aborted
        ) {
          throw new DeveloperSearchError({
            message: `Firecrawl developer search timed out after ${requestTimeoutMs / 1_000} seconds. ${RETRY_HINT}`,
          });
        }
        throw error;
      }
    },
    catch: (cause) =>
      cause instanceof DeveloperSearchError
        ? cause
        : new DeveloperSearchError({
            message: `Firecrawl developer search request failed: ${errorMessage(cause)}. ${RETRY_HINT}`,
            cause,
          }),
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function indexedEcho(value: unknown, key: "repo" | "source") {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate) => {
    const echo = record(candidate);
    const name = sanitizeLine(stringValue(echo?.[key]));
    return name ? [{ name, indexed: echo?.indexed === true, echo }] : [];
  });
}

/**
 * Normalizes a Developer Index response into sanitized persisted details.
 * Every remote string is terminal-sanitized; passage Markdown structure is
 * preserved because the model reads passages as quoted evidence.
 */
export function developerSearchDetails(
  response: DeveloperApiResponse,
): DeveloperSearchDetails {
  const results = Array.isArray(response.results)
    ? response.results.slice(0, MAX_DEVELOPER_SEARCH_LIMIT)
    : [];
  const coverageRecord = record(response.coverage);
  const coverage = Object.fromEntries(
    DEVELOPER_RESULT_TYPES.map((type) => [
      type,
      sanitizeLine(stringValue(coverageRecord?.[type])) || "unknown",
    ]),
  ) as Record<DeveloperResultType, string>;

  const repos = indexedEcho(response.repos, "repo")?.map(
    ({ name, indexed, echo }) => {
      const types = record(echo?.types);
      return {
        repo: name,
        indexed,
        ...(types
          ? {
              types: {
                issue: types.issue === true,
                pullRequest: types.pullRequest === true,
                readme: types.readme === true,
              },
            }
          : {}),
      };
    },
  );
  const sources = indexedEcho(response.sources, "source")?.map(
    ({ name, indexed }) => ({ source: name, indexed }),
  );

  return {
    backend: "firecrawl",
    results: results.flatMap((candidate): DeveloperSearchItem[] => {
      const item = record(candidate);
      const url = sanitizeLine(stringValue(item?.url));
      if (!url) return [];
      return [
        {
          id: sanitizeLine(stringValue(item?.id)),
          type: sanitizeLine(stringValue(item?.type)) || "unknown",
          title: sanitizeLine(stringValue(item?.title)) || url,
          url,
          passages: (Array.isArray(item?.passages)
            ? item.passages.slice(0, MAX_PASSAGES_PER_RESULT)
            : []
          ).flatMap((passage) => {
            const text = sanitizeText(
              typeof passage === "string"
                ? passage
                : stringValue(record(passage)?.text),
            )
              .trim()
              .slice(0, MAX_PASSAGE_CHARS);
            return text ? [text] : [];
          }),
        },
      ];
    }),
    coverage,
    reranked: response.reranked === true,
    ...(repos?.length ? { repos } : {}),
    ...(sources?.length ? { sources } : {}),
  };
}

/** Re-validates restored session details before rendering. */
export function developerSearchView(value: unknown): DeveloperSearchDetails {
  return developerSearchDetails(record(value) ?? {});
}

function coverageLine(coverage: Record<DeveloperResultType, string>) {
  return DEVELOPER_RESULT_TYPES.map((type) => `${type} ${coverage[type]}`).join(
    " · ",
  );
}

function notIndexedLine(details: DeveloperSearchDetails) {
  const missing = [
    ...(details.repos ?? [])
      .filter((echo) => !echo.indexed)
      .map((echo) => `repo ${echo.repo}`),
    ...(details.sources ?? [])
      .filter((echo) => !echo.indexed)
      .map((echo) => `source ${echo.source}`),
  ];
  return missing.length > 0 ? `Not indexed: ${missing.join(", ")}` : "";
}

/**
 * Model-facing result text. Passages are quoted, indented evidence; the
 * routing guidelines instruct the model to never treat them as instructions.
 */
export function developerSearchResultText(details: DeveloperSearchDetails) {
  const sections = [`Coverage: ${coverageLine(details.coverage)}`];

  if (details.results.length === 0) {
    sections.push("No developer search results returned.");
  }
  for (const [index, item] of details.results.entries()) {
    const lines = [
      `${index + 1}. [${item.type}] ${item.title}`,
      `   URL: ${item.url}`,
    ];
    if (item.id) lines.push(`   ID: ${item.id}`);
    for (const passage of item.passages) {
      lines.push(...passage.split("\n").map((line) => `   ${line}`));
    }
    sections.push(lines.join("\n"));
  }

  const missing = notIndexedLine(details);
  if (missing) sections.push(missing);
  return sections.join("\n\n");
}

async function developerSearch(
  getApiKey: OptionalFirecrawlKeyProvider,
  options: DeveloperSearchOptions,
  signal?: AbortSignal,
  transport: DeveloperSearchTransport = {},
): Promise<DeveloperSearchDetails> {
  const request = buildDeveloperSearchRequest(options);
  const program = Effect.sync(getApiKey).pipe(
    Effect.flatMap((apiKey) =>
      developerSearchRequest(request, apiKey, transport),
    ),
    Effect.map(developerSearchDetails),
  );

  const exit = await Effect.runPromiseExit(
    program,
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("Firecrawl developer search cancelled");
  }
  const error = Cause.squash(exit.cause);
  throw error instanceof Error ? error : new Error(errorMessage(error));
}

export interface DeveloperSearchToolDependencies {
  getApiKey: OptionalFirecrawlKeyProvider;
  transport?: DeveloperSearchTransport;
}

export function registerDeveloperSearchTool(
  pi: ExtensionAPI,
  { getApiKey, transport }: DeveloperSearchToolDependencies,
) {
  pi.registerTool({
    name: "developer-search",
    label: "Search Developer Index",
    description: DEVELOPER_SEARCH_TOOL_DESCRIPTION,
    promptSnippet: DEVELOPER_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: DEVELOPER_SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.query,
        minLength: 1,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: MAX_DEVELOPER_SEARCH_LIMIT,
        }),
      ),
      types: Type.Optional(
        Type.Array(StringEnum(DEVELOPER_RESULT_TYPES), {
          description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.types,
        }),
      ),
      repos: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
          description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.repos,
          maxItems: 20,
        }),
      ),
      sources: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
          description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.sources,
          maxItems: 20,
        }),
      ),
      passages: Type.Optional(
        Type.Integer({
          description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.passages,
          minimum: 1,
          maximum: MAX_PASSAGES_PER_RESULT,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Searching the Developer Index for: ${sanitizeLine(params.query)}`,
          },
        ],
        details: undefined,
      });

      const details = await developerSearch(
        getApiKey,
        {
          query: params.query,
          limit: params.limit ?? DEFAULT_DEVELOPER_SEARCH_LIMIT,
          types: params.types,
          repos: params.repos,
          sources: params.sources,
          passages: params.passages,
        },
        signal,
        transport,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: await boundedOutput(
              developerSearchResultText(details),
              "developer-search",
            ),
          },
        ],
        details,
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("developer-search"));
      text += ` ${theme.fg("accent", `“${sanitizeLine(args.query)}”`)}`;
      text += theme.fg(
        "muted",
        ` · limit ${args.limit ?? DEFAULT_DEVELOPER_SEARCH_LIMIT}`,
      );
      if (args.types?.length) {
        text += theme.fg("muted", ` · ${args.types.join(", ")}`);
      }
      if (args.repos?.length) {
        text += theme.fg(
          "muted",
          ` · in ${args.repos.map(sanitizeLine).join(", ")}`,
        );
      }
      if (args.sources?.length) {
        text += theme.fg(
          "muted",
          ` · docs ${args.sources.map(sanitizeLine).join(", ")}`,
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
        return errorResult(result, theme, "Developer search failed");
      }

      const details = developerSearchView(result.details);
      const degraded = DEVELOPER_RESULT_TYPES.filter(
        (type) => !["ok", "skipped"].includes(details.coverage[type]),
      );
      let text = theme.fg(
        "success",
        `✓ ${details.results.length} result${details.results.length === 1 ? "" : "s"}`,
      );
      if (degraded.length > 0) {
        text += theme.fg(
          "warning",
          ` · ${degraded.map((type) => `${type} ${details.coverage[type]}`).join(", ")}`,
        );
      }

      const visible = expanded ? details.results : details.results.slice(0, 3);
      for (const [index, item] of visible.entries()) {
        text += `\n${theme.fg("accent", `${index + 1}. [${item.type}] ${item.title}`)}`;
        if (item.url) {
          text += theme.fg("dim", ` — ${displayUrl(item.url)}`);
        }
        if (expanded && item.passages[0]) {
          text += `\n   ${theme.fg("muted", summaryLine(item.passages[0]))}`;
        }
        if (expanded && item.url) {
          text += `\n   ${theme.fg("dim", item.url)}`;
        }
      }
      if (!expanded && details.results.length > visible.length) {
        text += `\n${theme.fg("dim", `… ${details.results.length - visible.length} more`)}`;
      }
      if (expanded) {
        const missing = notIndexedLine(details);
        if (missing) text += `\n${theme.fg("warning", missing)}`;
      } else {
        text += `\n${expandHint(theme)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
