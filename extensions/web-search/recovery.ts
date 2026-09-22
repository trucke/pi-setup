import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FetchError } from "../shared/fetch-error.ts";
import { abortable } from "../shared/public-http.ts";
import { reviewText, type PreviewContext } from "./preview.ts";
import {
  buildReport,
  REPORT_REPO,
  REPORT_TITLE,
  submitReport,
  validateReproduction,
} from "./report.ts";

type UI = Pick<
  ExtensionContext["ui"],
  "select" | "input" | "notify" | "custom"
>;
type RecoveryContext = PreviewContext & { ui: UI };

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

async function optIn(ui: UI, title: string, yes: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const choice = await ui.select(title, ["No", yes], { signal });
  signal.throwIfAborted();
  return choice === yes;
}

export async function offerReport(
  ctx: RecoveryContext,
  failure: FetchError,
  timeout: number,
  signal: AbortSignal,
  dependencies = { validate: validateReproduction, submit: submitReport },
) {
  const { ui } = ctx;
  if (
    !(await optIn(
      ui,
      "Offer a reproduction report to the maintainer? Nothing is sent yet.",
      "Prepare report",
      signal,
    ))
  )
    return;
  const input = await ui.input(
    "Supply a PUBLIC, NON-SENSITIVE reproduction URL (no query/fragment, max 300 characters). Original URL is never prefilled.",
    undefined,
    { signal },
  );
  signal.throwIfAborted();
  if (!input) return;
  let reproduction: string;
  try {
    reproduction = await dependencies.validate(input, signal);
  } catch {
    if (!signal.aborted)
      ui.notify(
        "Report not sent: reproduction URL could not be validated as public.",
        "warning",
      );
    return;
  }
  const body = buildReport(reproduction, failure, timeout);
  if (!(await reviewText(ctx, `Title: ${REPORT_TITLE}\n\n${body}`, signal)))
    return;
  if (
    !(await optIn(
      ui,
      `Publish the reviewed report publicly to ${REPORT_REPO} under your signed-in GitHub account (NOT anonymous)?\nBy publishing, you certify the supplied hostname AND path are public and non-sensitive.`,
      "I certify and publish",
      signal,
    ))
  )
    return;
  try {
    await dependencies.submit(reproduction, failure, timeout, signal);
    ui.notify(
      "Reproduction report published to trucke/pi-setup on GitHub.",
      "info",
    );
  } catch {
    // A killed or failed CLI may already have completed its remote write.
    ui.notify(
      "Report submission was not confirmed. An issue may already exist at https://github.com/trucke/pi-setup/issues. Check before retrying. No automatic retry was made.",
      "warning",
    );
  }
}

export async function recoverFetch<T>(options: {
  local: () => Promise<T>;
  hosted: () => Promise<T>;
  url: string;
  timeout: number;
  ctx: RecoveryContext & Pick<ExtensionContext, "hasUI">;
  signal: AbortSignal;
  queue: ReturnType<typeof createRecoveryQueue>;
  report?: typeof offerReport;
}) {
  const { signal, ctx } = options;
  try {
    return await options.local();
  } catch (failure) {
    if (
      !(failure instanceof FetchError) ||
      ["unsafe", "invalid", "cancelled"].includes(failure.category) ||
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
          if (failure.recoverable) {
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
          }
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
        signal.throwIfAborted();
        try {
          await (options.report ?? offerReport)(
            ctx,
            failure,
            options.timeout,
            signal,
          );
        } catch {
          /* Optional reporting must not replace the fetch outcome. */
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
