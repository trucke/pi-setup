import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Schedule } from "effect";
import {
  emptyVcsInfoState,
  REFRESH_CHANNEL,
  type PullRequestInfo,
  VCS_INFO_CHANNEL,
} from "../shared/dashboard-state.ts";
import {
  loadChangedFiles,
  showChangedFiles,
} from "./src/changed-files-view.ts";
import { runCommand, type CommandRunner } from "./src/process.ts";
import { makeRefreshCoordinator } from "./src/refresh-coordinator.ts";
import {
  createRuntime,
  runEffect,
  type VcsInfoRuntime,
} from "./src/runtime.ts";
import { loadVcsSnapshot } from "./src/vcs.ts";

const POLL_INTERVAL_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;

function parsePullRequest(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || value.state !== "OPEN") return null;

  return {
    number: value.number,
    url: value.url,
    isDraft: "isDraft" in value && value.isDraft === true,
  } satisfies PullRequestInfo;
}

function parsePullRequestJson(value: string) {
  try {
    return parsePullRequest(JSON.parse(value));
  } catch {
    return null;
  }
}

export default function vcsInfo(pi: ExtensionAPI) {
  let state = emptyVcsInfoState();
  let runtime: VcsInfoRuntime | undefined;
  let pollingFiber: Fiber.Fiber<void> | undefined;
  let currentContext: ExtensionContext | undefined;
  let generation = 0;
  let queriedPullRequestKey: string | null = null;
  const refreshCoordinator = makeRefreshCoordinator();

  const getRuntime = () => (runtime ??= createRuntime());
  const publish = () => pi.events.emit(VCS_INFO_CHANNEL, { ...state });

  const lookupPullRequest = (ctx: ExtensionContext, refs: string[]) =>
    Effect.gen(function* () {
      for (const ref of refs) {
        const result = yield* runCommand(
          "gh",
          ["pr", "view", ref, "--json", "number,url,state,isDraft"],
          ctx.cwd,
          GH_TIMEOUT_MS,
        );
        if (result.code !== 0) continue;

        const pullRequest = parsePullRequestJson(result.stdout);
        if (pullRequest) return pullRequest;
      }
      return null;
    });

  const refreshEffect = (
    ctx: ExtensionContext,
    forcePullRequest: boolean,
    refreshGeneration: number,
    snapshotWorkingCopy: boolean,
  ) =>
    Effect.suspend(() => {
      if (refreshGeneration !== generation) return Effect.void;
      currentContext = ctx;

      return Effect.gen(function* () {
        const snapshot = yield* loadVcsSnapshot(ctx.cwd, snapshotWorkingCopy);
        if (refreshGeneration !== generation) return;

        if (!snapshot) {
          queriedPullRequestKey = null;
          state = emptyVcsInfoState();
          publish();
          return;
        }

        const pullRequestKey = `${snapshot.kind}:${snapshot.pullRequestRefs.join("\0")}`;
        const referenceChanged = pullRequestKey !== queriedPullRequestKey;
        state = {
          isRepository: true,
          kind: snapshot.kind,
          label: snapshot.label,
          changedFiles: snapshot.changedFiles,
          pullRequest: referenceChanged ? null : state.pullRequest,
        };
        publish();

        if (snapshot.pullRequestRefs.length === 0) {
          queriedPullRequestKey = null;
          return;
        }

        if (forcePullRequest || referenceChanged) {
          queriedPullRequestKey = pullRequestKey;
          const pullRequest = yield* lookupPullRequest(
            ctx,
            snapshot.pullRequestRefs,
          );
          if (refreshGeneration !== generation) return;
          state = { ...state, pullRequest };
          publish();
        }
      });
    });

  const refresh = (ctx: ExtensionContext, forcePullRequest = false) =>
    refreshCoordinator.run(
      refreshEffect(ctx, forcePullRequest, generation, true),
    );

  const refreshIfIdle = (ctx: ExtensionContext, snapshotWorkingCopy: boolean) =>
    refreshCoordinator.runIfIdle(
      refreshEffect(ctx, false, generation, snapshotWorkingCopy),
    );

  const reportBackgroundDefect = (defect: unknown) =>
    Effect.logError("vcs-info background task defect", defect);

  const poll = () =>
    Effect.suspend(() =>
      currentContext ? refreshIfIdle(currentContext, false) : Effect.void,
    ).pipe(
      Effect.catchDefect(reportBackgroundDefect),
      Effect.repeat(Schedule.fixed(POLL_INTERVAL_MS)),
      Effect.delay(POLL_INTERVAL_MS),
      Effect.asVoid,
    );

  const forkBackground = (effect: Effect.Effect<void, never, CommandRunner>) =>
    getRuntime().runFork(
      effect.pipe(Effect.catchDefect(reportBackgroundDefect)),
    );

  const refreshInBackground = (ctx: ExtensionContext) => {
    forkBackground(refreshIfIdle(ctx, true));
  };

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refreshInBackground(currentContext);
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    queriedPullRequestKey = null;

    const previousPollingFiber = pollingFiber;
    pollingFiber = undefined;
    if (previousPollingFiber) {
      await getRuntime().runPromise(Fiber.interrupt(previousPollingFiber));
    }

    // Do not block Pi startup on GitHub/network I/O. The initial refresh publishes
    // state when it completes; polling continues to keep it current afterwards.
    refreshInBackground(ctx);
    pollingFiber = forkBackground(poll());
  });

  pi.on("input", (_event, ctx) => {
    refreshInBackground(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    refreshInBackground(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopRefreshListener();
    generation += 1;
    currentContext = undefined;
    pollingFiber = undefined;
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });

  pi.registerCommand("lg", {
    description: "Browse changed files and their diffs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The local changes viewer requires the interactive TUI",
          "warning",
        );
        return;
      }

      const files = await runEffect(getRuntime(), loadChangedFiles(ctx.cwd), {
        signal: ctx.signal,
        interruptMessage: "Loading changed files was cancelled.",
      });
      if (files === null) {
        ctx.ui.notify("Not a Git or JJ repository", "warning");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify("Working copy is clean", "info");
        return;
      }

      await showChangedFiles(ctx, files);
    },
  });

  pi.registerCommand("pr", {
    description: "Refresh VCS and pull request information",
    handler: async (_args, ctx) => {
      await runEffect(getRuntime(), refresh(ctx, true), {
        signal: ctx.signal,
        interruptMessage: "VCS and pull request refresh was cancelled.",
      });
      if (!state.isRepository) {
        ctx.ui.notify("Not a Git or JJ repository", "warning");
      } else if (state.pullRequest) {
        ctx.ui.notify(
          `PR #${state.pullRequest.number}: ${state.pullRequest.url}`,
          "info",
        );
      } else {
        ctx.ui.notify(`No open PR found for ${state.label}`, "info");
      }
    },
  });
}
