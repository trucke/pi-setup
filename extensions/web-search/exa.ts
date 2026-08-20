import { Cause, Data, Effect, Exit } from "effect";
import {
  MissingApiKeyError,
  resolveApiKey,
  type ApiKeyOptions,
  type CommandExecutor,
} from "./env.ts";
import { errorMessage } from "./output.ts";
import { sanitizeLine, sanitizeText } from "./sanitize.ts";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
export const EXA_SEARCH_TIMEOUT_MS = 60_000;
export const EXA_CONTENTS_TIMEOUT_MS = 90_000;

/** Bounds one persisted excerpt so details cannot bloat the session. */
const MAX_SNIPPET_CHARS = 1_500;

/** Narrow hand-written subset of the Exa result shape; the rest is ignored. */
interface ExaApiResult {
  title?: string | null;
  url?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
}

interface ExaSearchResponse {
  results?: ExaApiResult[];
}

interface ExaContentsStatus {
  id?: string;
  status?: string;
  error?: { tag?: string; httpStatusCode?: number | null };
}

interface ExaContentsResponse {
  results?: ExaApiResult[];
  statuses?: ExaContentsStatus[];
}

/** Normalized, sanitized, persisted search details. */
export interface ExaSearchItem {
  title: string;
  url: string;
  publishedDate?: string;
  snippet: string;
}

export interface ExaSearchDetails {
  backend: "exa";
  results: ExaSearchItem[];
}

/** Normalized fetch details; page text stays in the tool output, not here. */
export interface ExaPageView {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  characters: number;
}

export interface ExaFetchDetails {
  backend: "exa";
  pages: ExaPageView[];
  errors: Array<{ url: string; reason: string }>;
}

export type RecencyFilter = "hour" | "day" | "week" | "month" | "year";

const RECENCY_OFFSET_MS: Record<RecencyFilter, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

export interface ExaSearchOptions {
  query: string;
  limit: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  recency?: RecencyFilter;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Builds the Exa Search request. Requests only query-targeted highlights to
 * keep the default backend cheap; full content goes through web-fetch.
 */
export function buildExaSearchRequest(options: ExaSearchOptions) {
  const now = options.now ?? Date.now;
  return {
    query: options.query,
    type: "auto",
    numResults: options.limit,
    ...(options.includeDomains?.length
      ? { includeDomains: options.includeDomains }
      : {}),
    ...(options.excludeDomains?.length
      ? { excludeDomains: options.excludeDomains }
      : {}),
    ...(options.recency
      ? {
          startPublishedDate: new Date(
            now() - RECENCY_OFFSET_MS[options.recency],
          ).toISOString(),
        }
      : {}),
    contents: {
      highlights: { query: options.query },
    },
  };
}

export interface ExaContentsOptions {
  url: string;
  maxCharacters?: number;
  fresh?: boolean;
}

/** Builds the Exa Contents request for one arbitrary known URL. */
export function buildExaContentsRequest(options: ExaContentsOptions) {
  return {
    ids: [options.url],
    contents: {
      text: options.maxCharacters
        ? { maxCharacters: options.maxCharacters }
        : true,
      livecrawl: options.fresh ? ("preferred" as const) : ("fallback" as const),
    },
  };
}

export type ExaKeyProvider = (signal?: AbortSignal) => Promise<string>;

/**
 * Lazily resolves and memoizes EXA_API_KEY with the shared credential policy
 * so a missing key cannot break extension loading.
 */
export function createExaKeyProvider(
  pi: CommandExecutor,
  options: ApiKeyOptions = {},
): ExaKeyProvider {
  let apiKey: string | undefined;
  let pending: Promise<string> | undefined;

  return async (signal) => {
    if (apiKey) return apiKey;
    pending ??= resolveApiKey("EXA_API_KEY", pi, signal, options);

    try {
      apiKey = await pending;
      return apiKey;
    } catch (error) {
      pending = undefined;
      throw error;
    }
  };
}

export interface ExaTransport {
  fetch?: typeof fetch;
  /** Test-only override of the per-operation timeout. */
  timeoutMs?: number;
}

/** Typed Exa failure; `message` is the complete model-facing error text. */
export class ExaError extends Data.TaggedError("ExaError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * One Exa HTTP call as an Effect: fiber interruption (tool cancellation)
 * aborts the in-flight request, and `AbortSignal.timeout` bounds the request
 * including body reads.
 *
 * The timeout deliberately stays on the web-standard unref'd signal instead
 * of `Effect.timeout`: in Effect v4.0.0-beta.98, interrupting a fiber inside
 * the timeout race leaks the raced sleep's timer, holding the event loop for
 * the full timeout after every cancelled call.
 */
function exaRequest<T>(
  operation: string,
  endpoint: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
  retryHint: string,
  transport: ExaTransport = {},
): Effect.Effect<T, ExaError> {
  const doFetch = transport.fetch ?? fetch;
  const requestTimeoutMs = transport.timeoutMs ?? timeoutMs;

  return Effect.tryPromise({
    try: async (signal) => {
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const combined = AbortSignal.any([signal, timeout]);

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: combined,
        });

        if (!response.ok) {
          const detail = sanitizeLine(
            await response.text().catch(() => ""),
          ).slice(0, 300);
          throw new ExaError({
            message: `Exa ${operation} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}. ${retryHint}`,
          });
        }

        try {
          return (await response.json()) as T;
        } catch (error) {
          throw new ExaError({
            message: `Exa ${operation} returned invalid JSON: ${errorMessage(error)}. ${retryHint}`,
            cause: error,
          });
        }
      } catch (error) {
        if (
          !(error instanceof ExaError) &&
          timeout.aborted &&
          !signal.aborted
        ) {
          throw new ExaError({
            message: `Exa ${operation} timed out after ${requestTimeoutMs / 1_000} seconds. ${retryHint}`,
          });
        }
        throw error;
      }
    },
    catch: (cause) =>
      cause instanceof ExaError
        ? cause
        : new ExaError({
            message: `Exa ${operation} request failed: ${errorMessage(cause)}. ${retryHint}`,
            cause,
          }),
  });
}

function boundedSnippet(item: ExaApiResult) {
  const highlights = Array.isArray(item.highlights)
    ? item.highlights.filter(
        (highlight): highlight is string =>
          typeof highlight === "string" && highlight.trim().length > 0,
      )
    : [];
  const snippet =
    highlights.length > 0 ? highlights.join("\n") : (item.text ?? "");
  return sanitizeText(snippet).trim().slice(0, MAX_SNIPPET_CHARS);
}

/** Normalizes an Exa Search response into sanitized persisted details. */
export function exaSearchDetails(
  response: ExaSearchResponse,
): ExaSearchDetails {
  const results = Array.isArray(response.results) ? response.results : [];
  return {
    backend: "exa",
    results: results.flatMap((item): ExaSearchItem[] => {
      const url = sanitizeLine(item.url ?? "");
      if (!url) return [];
      return [
        {
          title: sanitizeLine(item.title ?? "") || url,
          url,
          ...(item.publishedDate
            ? { publishedDate: sanitizeLine(item.publishedDate) }
            : {}),
          snippet: boundedSnippet(item),
        },
      ];
    }),
  };
}

export interface ExaFetchResult {
  details: ExaFetchDetails;
  output: string;
}

/** Normalizes an Exa Contents response into details plus model-facing text. */
export function exaFetchResult(
  response: ExaContentsResponse,
  requestedUrl: string,
  retryHint: string,
): ExaFetchResult {
  const results = Array.isArray(response.results) ? response.results : [];
  const statuses = Array.isArray(response.statuses) ? response.statuses : [];
  const errors = statuses
    .filter((status) => status.status === "error")
    .map((status) => ({
      url: sanitizeLine(status.id ?? requestedUrl),
      reason: sanitizeLine(status.error?.tag ?? "unknown error"),
    }));

  const pages: ExaPageView[] = [];
  const sections: string[] = [];
  for (const item of results) {
    const url = sanitizeLine(item.url ?? requestedUrl);
    const title = sanitizeLine(item.title ?? "") || url;
    const text = sanitizeText(item.text ?? "").trim();
    pages.push({
      title,
      url,
      ...(item.publishedDate
        ? { publishedDate: sanitizeLine(item.publishedDate) }
        : {}),
      ...(item.author ? { author: sanitizeLine(item.author) } : {}),
      characters: text.length,
    });

    const header = [`# ${title}`, `URL: ${url}`];
    if (item.publishedDate) {
      header.push(`Published: ${sanitizeLine(item.publishedDate)}`);
    }
    if (item.author) header.push(`Author: ${sanitizeLine(item.author)}`);
    sections.push(
      `${header.join("\n")}\n\n${text || "_No text content returned._"}`,
    );
  }

  if (pages.length === 0) {
    const reasons = errors.map((error) => `${error.url}: ${error.reason}`);
    throw new Error(
      reasons.length > 0
        ? `Exa fetch failed for ${requestedUrl} (${reasons.join("; ")}). ${retryHint}`
        : `Exa returned no content for ${requestedUrl}. ${retryHint}`,
    );
  }

  for (const error of errors) {
    sections.push(`Error fetching ${error.url}: ${error.reason}`);
  }

  return {
    details: { backend: "exa", pages, errors },
    output: sections.join("\n\n"),
  };
}

/** Resolves the memoized API key, keeping the missing-key case tag-typed. */
function exaApiKey(
  getApiKey: ExaKeyProvider,
): Effect.Effect<string, ExaError | MissingApiKeyError> {
  return Effect.tryPromise({
    try: (signal) => getApiKey(signal),
    catch: (cause) =>
      cause instanceof MissingApiKeyError
        ? cause
        : new ExaError({ message: errorMessage(cause), cause }),
  });
}

/**
 * Promise boundary for the tool API: success value, or a thrown Error whose
 * message names the explicit retry. Tool cancellation interrupts the fiber
 * and reports distinctly from failures.
 */
async function runExa<A>(
  effect: Effect.Effect<A, ExaError | MissingApiKeyError>,
  operation: string,
  retryHint: string,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    effect,
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted || Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(`Exa ${operation} cancelled`);
  }

  const error = Cause.squash(exit.cause);
  if (error instanceof MissingApiKeyError) {
    throw new Error(`${error.message}. ${retryHint}`);
  }
  throw error instanceof Error ? error : new Error(errorMessage(error));
}

export function exaSearch(
  getApiKey: ExaKeyProvider,
  options: ExaSearchOptions,
  retryHint: string,
  signal?: AbortSignal,
  transport: ExaTransport = {},
) {
  const program = Effect.gen(function* () {
    const apiKey = yield* exaApiKey(getApiKey);
    const response = yield* exaRequest<ExaSearchResponse>(
      "search",
      EXA_SEARCH_URL,
      buildExaSearchRequest(options),
      apiKey,
      EXA_SEARCH_TIMEOUT_MS,
      retryHint,
      transport,
    );
    return exaSearchDetails(response);
  });
  return runExa(program, "search", retryHint, signal);
}

export function exaFetch(
  getApiKey: ExaKeyProvider,
  options: ExaContentsOptions,
  retryHint: string,
  signal?: AbortSignal,
  transport: ExaTransport = {},
) {
  const program = Effect.gen(function* () {
    const apiKey = yield* exaApiKey(getApiKey);
    const response = yield* exaRequest<ExaContentsResponse>(
      "fetch",
      EXA_CONTENTS_URL,
      buildExaContentsRequest(options),
      apiKey,
      EXA_CONTENTS_TIMEOUT_MS,
      retryHint,
      transport,
    );
    // exaFetchResult stays a pure throwing helper; adopt its failure here.
    return yield* Effect.try({
      try: () => exaFetchResult(response, options.url, retryHint),
      catch: (cause) => new ExaError({ message: errorMessage(cause), cause }),
    });
  });
  return runExa(program, "fetch", retryHint, signal);
}
