import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { Cause, Data, Effect, Exit } from "effect";
import type { CrawlJob, CrawlOptions, Firecrawl } from "firecrawl";
import {
  MissingApiKeyError,
  resolveApiKey,
  type ApiKeyOptions,
  type CommandExecutor,
} from "./env.ts";
import { boundedOutput, errorMessage } from "./output.ts";

/** Firecrawl's documented default search timeout. */
export const FIRECRAWL_SEARCH_TIMEOUT_MS = 60_000;

export class FirecrawlError extends Data.TaggedError("FirecrawlError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class FirecrawlTimeoutError extends Data.TaggedError("FirecrawlTimeoutError")<{
  readonly timeoutMs: number;
}> {}

/**
 * Races an operation against an unref'd timer whose cleanup runs on every exit.
 * Effect v4.0.0-beta.98 can retain the timer behind `Effect.timeout` when the
 * outer fiber is interrupted, so cancelled calls could otherwise prevent a
 * short-lived process from exiting until the full request timeout elapsed.
 */
function withUnrefTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
) {
  const timeout = Effect.callback<never, FirecrawlTimeoutError>((resume) => {
    const timer = setTimeout(
      () => resume(Effect.fail(new FirecrawlTimeoutError({ timeoutMs }))),
      timeoutMs,
    );
    timer.unref();
    return Effect.sync(() => clearTimeout(timer));
  });
  return Effect.raceFirst(effect, timeout);
}

export type FirecrawlProvider = (signal?: AbortSignal) => Promise<Firecrawl>;

export function createFirecrawlProvider(
  pi: CommandExecutor,
  options: ApiKeyOptions = {},
): FirecrawlProvider {
  let client: Firecrawl | undefined;
  let pending: Promise<Firecrawl> | undefined;

  return async (signal) => {
    if (client) return client;
    pending ??= resolveApiKey("FIRECRAWL_API_KEY", pi, signal, options).then(
      async (apiKey) => {
        // Firecrawl pulls in Axios/follow-redirects, which can intermittently
        // fail during extension loading under Bun. Keep it off Pi's startup
        // path.
        const { Firecrawl } = await import("firecrawl");
        return new Firecrawl({ apiKey });
      },
    );

    try {
      client = await pending;
      return client;
    } catch (error) {
      pending = undefined;
      throw error;
    }
  };
}

function createClient(provider: FirecrawlProvider) {
  return Effect.tryPromise({
    try: (signal) => provider(signal),
    catch: (cause) =>
      cause instanceof MissingApiKeyError
        ? cause
        : new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

export function firecrawlRequest<T>(request: () => Promise<T>) {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

export function firecrawlOutputError(cause: unknown) {
  return new OutputError({ message: errorMessage(cause), cause });
}

export type CrawlClient = Pick<
  Firecrawl,
  "startCrawl" | "getCrawlStatus" | "cancelCrawl"
>;

function pollCrawl(
  client: CrawlClient,
  jobId: string,
): Effect.Effect<CrawlJob, FirecrawlError> {
  return firecrawlRequest(() =>
    client.getCrawlStatus(jobId, { autoPaginate: false }),
  ).pipe(
    Effect.flatMap((job) => {
      if (job.status === "scraping") {
        return Effect.sleep("2 seconds").pipe(
          Effect.flatMap(() => Effect.suspend(() => pollCrawl(client, jobId))),
        );
      }
      return job.next
        ? firecrawlRequest(() => client.getCrawlStatus(jobId))
        : Effect.succeed(job);
    }),
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
        : withUnrefTimeout(
            firecrawlRequest(() => client.cancelCrawl(job.id)),
            10_000,
          ).pipe(Effect.ignore),
  );
}

function operationError(operation: string, error: unknown, retryHint: string) {
  if (error instanceof MissingApiKeyError) {
    return new Error(`${error.message}. ${retryHint}`);
  }
  if (error instanceof FirecrawlTimeoutError) {
    return new Error(
      `Firecrawl ${operation} timed out after ${error.timeoutMs / 1_000} seconds. ${retryHint}`,
      { cause: error },
    );
  }

  const cause =
    error instanceof FirecrawlError || error instanceof OutputError
      ? error.cause
      : error;
  return new Error(
    `Firecrawl ${operation} failed: ${errorMessage(error)}. ${retryHint}`,
    { cause },
  );
}

/** Shared Effect pipeline with a single Promise boundary for the tool API. */
export async function runFirecrawl<T>(
  getClient: FirecrawlProvider,
  operation: string,
  status: string,
  timeout: number,
  retryHint: string,
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
    const client = yield* createClient(getClient);
    yield* Effect.sync(() =>
      onUpdate?.({
        content: [{ type: "text", text: status }],
        details: undefined,
      }),
    );

    const { details, output } = yield* withUnrefTimeout(
      request(client),
      timeout,
    );
    const formatted = yield* Effect.tryPromise({
      try: () => boundedOutput(output, operation, "json"),
      catch: firecrawlOutputError,
    });

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
  throw operationError(operation, Cause.squash(exit.cause), retryHint);
}
