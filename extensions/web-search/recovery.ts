import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FetchError } from "../shared/fetch-error.ts";
import { withHerdrBlocked } from "../shared/herdr.ts";
import { abortable } from "../shared/public-http.ts";
import { errorMessage } from "./output.ts";

/** Serialize quota dialogs, without serializing hosted requests. */
export function createRecoveryQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(signal: AbortSignal, work: () => Promise<T>) => {
    const next = tail
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return work();
      });
    tail = next.catch(() => {});
    return abortable(next, signal);
  };
}

export async function approveQuotaFallback(options: {
  pi: Pick<ExtensionAPI, "events">;
  ctx: Pick<ExtensionContext, "hasUI"> & {
    ui: Pick<ExtensionContext["ui"], "select">;
  };
  signal: AbortSignal;
  queue: ReturnType<typeof createRecoveryQueue>;
}) {
  const { pi, ctx, signal, queue } = options;
  if (!ctx.hasUI || signal.aborted) return false;
  try {
    return await queue(signal, () =>
      withHerdrBlocked(pi, "Waiting for web fetch quota approval", async () => {
        const choice = await ctx.ui.select(
          "Exa reported a quota or billing limit. Try this request through Firecrawl's anonymous endpoint instead? No paid access will be used.",
          ["No", "Try Firecrawl"],
          { signal },
        );
        signal.throwIfAborted();
        return choice === "Try Firecrawl";
      }),
    );
  } catch {
    // A dismissed, failed or cancelled dialog never authorizes a quota fallback.
    return false;
  }
}

export async function recoverFetch<T>(options: {
  local: () => Promise<T>;
  hosted: () => Promise<T>;
  note: () => void;
  signal: AbortSignal;
}) {
  try {
    return await options.local();
  } catch (failure) {
    if (
      !(failure instanceof FetchError) ||
      !failure.recoverable ||
      options.signal.aborted
    )
      throw failure;
    options.note();
    options.signal.throwIfAborted();
    try {
      return await options.hosted();
    } catch (error) {
      throw new Error(
        `Local attempt: ${failure.message}\nHosted attempt: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}
