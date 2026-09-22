import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import { Type } from "typebox";
import { resolveOptionalApiKey, type ApiKeyOptions } from "./env.ts";
import { boundedOutput, errorMessage } from "./output.ts";
import { webRenderers } from "./render.ts";
import { readResponseText } from "../shared/public-http.ts";
import {
  DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS,
  DEVELOPER_SEARCH_PROMPT_GUIDELINES,
  DEVELOPER_SEARCH_PROMPT_SNIPPET,
  DEVELOPER_SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { sanitizeLine, sanitizeText } from "./sanitize.ts";

export const DEVELOPER_SEARCH_URL =
  "https://api.firecrawl.dev/v2/search/developer";
export const DEVELOPER_SEARCH_TIMEOUT_MS = 60_000;

export const DEFAULT_DEVELOPER_SEARCH_LIMIT = 10;
/** Matches the upstream `k` limit. */
export const MAX_DEVELOPER_SEARCH_LIMIT = 100;
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
 * Developer Index response. Remote fields are validated and bounded during
 * normalization before producing quoted evidence.
 */
interface DeveloperApiResponse {
  results?: unknown;
  coverage?: unknown;
  reranked?: unknown;
  repos?: unknown;
  sources?: unknown;
}

/** Normalized, sanitized developer-search evidence. */
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
  coverage: Record<DeveloperResultType, string> | undefined;
  reranked: boolean;
  repos?: Array<{
    repo: string;
    canonicalRepo?: string;
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
 * upstream `k` with the same result limit.
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
 * One Developer Index HTTP call as an Effect:
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
        combined.throwIfAborted();
        const response = await doFetch(DEVELOPER_SEARCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Keyless by default; Authorization only when a key is configured.
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: combined,
          redirect: "error",
        });
        const responseText = await readResponseText(response, combined);

        if (!response.ok) {
          const detail = sanitizeLine(
            apiKey
              ? responseText.replaceAll(apiKey, "[redacted]")
              : responseText,
          ).slice(0, 300);
          throw new DeveloperSearchError({
            message: `Firecrawl developer search failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}. ${RETRY_HINT}`,
          });
        }

        try {
          const parsed: unknown = JSON.parse(responseText);
          if (!record(parsed)) throw new Error("Expected an object response");
          return parsed as DeveloperApiResponse;
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
  return typeof value === "string" ? value.slice(0, 8192) : "";
}

function indexedEcho(value: unknown, key: "repo" | "source") {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 20).flatMap((candidate) => {
    const echo = record(candidate);
    const name = sanitizeLine(stringValue(echo?.[key]));
    return name ? [{ name, indexed: echo?.indexed === true, echo }] : [];
  });
}

/**
 * Normalizes a Developer Index response into bounded evidence.
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
      sanitizeLine(stringValue(coverageRecord?.[type])).slice(0, 100) ||
        "unknown",
    ]),
  ) as Record<DeveloperResultType, string>;

  const repos = indexedEcho(response.repos, "repo")?.map(
    ({ name, indexed, echo }) => {
      const types = record(echo?.types);
      return {
        repo: name,
        ...(stringValue(echo?.canonicalRepo)
          ? { canonicalRepo: sanitizeLine(stringValue(echo?.canonicalRepo)) }
          : {}),
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
          type:
            sanitizeLine(stringValue(item?.type)) ||
            DEVELOPER_RESULT_TYPES.find((type) =>
              stringValue(item?.id).startsWith(`${type}:`),
            ) ||
            "unknown",
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
    coverage: coverageRecord ? coverage : undefined,
    reranked: response.reranked === true,
    ...(repos?.length ? { repos } : {}),
    ...(sources?.length ? { sources } : {}),
  };
}

function coverageLine(coverage: DeveloperSearchDetails["coverage"]) {
  if (!coverage) return "not reported";
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
  for (const repo of details.repos ?? []) {
    if (repo.indexed)
      sections.push(
        `Repository: ${repo.repo}${repo.canonicalRepo && repo.canonicalRepo !== repo.repo ? ` → ${repo.canonicalRepo}` : ""} (indexed)`,
      );
  }

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
  if (signal?.aborted) throw new Error("Firecrawl developer search cancelled");
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
    ...webRenderers("developer-search"),
    description: DEVELOPER_SEARCH_TOOL_DESCRIPTION,
    promptSnippet: DEVELOPER_SEARCH_PROMPT_SNIPPET,
    promptGuidelines: DEVELOPER_SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: DEVELOPER_SEARCH_PARAMETER_DESCRIPTIONS.query,
        minLength: 1,
        maxLength: 4096,
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
      if (signal?.aborted)
        throw new Error("Firecrawl developer search cancelled");
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Searching the Developer Index for: ${sanitizeLine(params.query)}`,
          },
        ],
        details: undefined,
      });

      const apiKey = getApiKey();
      const details = await developerSearch(
        () => apiKey,
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

      const output = await boundedOutput(
        `Provider: Firecrawl Developer Index (${apiKey ? "account" : "anonymous"})\n\n${developerSearchResultText(details)}`,
        "developer-search",
      );
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          provider: "firecrawl-developer",
          auth: apiKey ? "account" : "anonymous",
          resultCount: details.results.length,
          coverage: details.coverage,
          ...output.details,
          repos: details.repos,
          items: details.results
            .slice(0, 3)
            .map(({ title, url }) => ({ title, url })),
        },
      };
    },
  });
}
