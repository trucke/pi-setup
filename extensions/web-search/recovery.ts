import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FetchError } from "../shared/fetch-error.ts";
import { withHerdrBlocked } from "../shared/herdr.ts";
import { abortable } from "../shared/public-http.ts";
import { reviewText, type PreviewContext } from "./preview.ts";

/** Serialize the whole interaction, not individual dialogs from parallel fetches. */
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

async function optIn(
  ui: PreviewContext["ui"],
  title: string,
  yes: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const choice = await ui.select(title, ["No", yes], { signal });
  signal.throwIfAborted();
  return choice === yes;
}

export async function recoverFetch<T>(options: {
  pi: Pick<ExtensionAPI, "events">;
  local: () => Promise<T>;
  hosted: () => Promise<T>;
  url: string;
  ctx: PreviewContext & Pick<ExtensionContext, "hasUI">;
  signal: AbortSignal;
  queue: ReturnType<typeof createRecoveryQueue>;
}) {
  const { signal, pi } = options;
  const ui = options.ctx.ui;
  const ctx: typeof options.ctx = {
    ...options.ctx,
    ui: {
      ...ui,
      select: (...args) =>
        withHerdrBlocked(pi, "Waiting for web fetch approval", () =>
          ui.select(...args),
        ),
      custom: (factory, settings) =>
        withHerdrBlocked(pi, "Waiting for web fetch review", () =>
          ui.custom(factory, settings),
        ),
    },
  };
  try {
    return await options.local();
  } catch (failure) {
    if (
      !(failure instanceof FetchError) ||
      !failure.recoverable ||
      !ctx.hasUI ||
      signal.aborted
    )
      throw failure;
    let result: T | undefined;
    let succeeded = false;
    let hostedFailed = false;
    try {
      await options.queue(signal, async () => {
        // JSON escaping preserves the exact URL while making terminal controls inert.
        let allowed = false;
        try {
          const url = JSON.stringify(new URL(options.url).href);
          const reviewed =
            url.length <= 180 || (await reviewText(ctx, url, signal));
          allowed =
            reviewed &&
            (await optIn(
              ctx.ui,
              `Local fetch failed. Send ${url.length <= 180 ? url : "the reviewed URL"} to Exa, with Firecrawl fallback, for THIS request only? Hosted services control redirects.`,
              "Allow this request",
              signal,
            ));
        } catch {
          /* A broken dialog never authorizes disclosure. */
        }
        signal.throwIfAborted();
        if (allowed) {
          try {
            result = await options.hosted();
            succeeded = true;
          } catch {
            hostedFailed = true;
          }
        }
      });
    } catch {
      /* Preserve local failure or successful hosted content. */
    }
    if (succeeded) return result as T;
    if (hostedFailed)
      throw new Error(
        `Local attempt: ${failure.message}\nThe consented hosted fetch also failed.`,
      );
    throw failure;
  }
}
