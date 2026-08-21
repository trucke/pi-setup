/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent-spawn: profile-driven or direct fire-and-forget spawn.
 * - subagent-wait: wait for all/any with an optional non-cancelling timeout.
 * - subagent-cancel: stop running work while preserving artifacts.
 * - subagent-send: steer or queue guidance with a structured receipt.
 * - subagent-resume: explicitly recover a persisted run.
 * - subagent-check/list: factual liveness, usage, readiness, and artifacts.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  ConcurrencyLimitError,
  formatElapsed,
  latestText,
  PROFILE_NAMES,
  REASONING_EFFORTS,
  SpawnError,
  type CandidateAttempt,
  type ExecutionCandidate,
  type ParentContext,
  type ReviewTarget,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatCompactTokens,
  formatContextUtilization,
} from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS,
  SUBAGENT_RESUME_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import {
  buildProfilePrompt,
  defaultReviewTarget,
  EXECUTION_PROFILES,
} from "./src/profiles.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface ReviewTargetInput {
  readonly type: ReviewTarget["type"];
  readonly branch?: string;
  readonly sha?: string;
  readonly number?: number;
}

export function resolveReviewTarget(
  input: ReviewTargetInput | undefined,
): ReviewTarget {
  if (!input || input.type === "uncommittedChanges") {
    return defaultReviewTarget();
  }
  if (input.type === "baseBranch") {
    const branch = input.branch?.trim();
    if (!branch)
      throw new Error("reviewTarget.branch is required for baseBranch.");
    if (
      !/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.endsWith("/") ||
      branch.endsWith(".") ||
      branch
        .split("/")
        .some(
          (component) =>
            !component ||
            component.startsWith(".") ||
            component.endsWith(".lock"),
        )
    ) {
      throw new Error("reviewTarget.branch must be a safe Git branch name.");
    }
    return { type: "baseBranch", branch };
  }
  if (input.type === "commit") {
    const sha = input.sha?.trim();
    if (!sha) throw new Error("reviewTarget.sha is required for commit.");
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
      throw new Error("reviewTarget.sha must be a 7-64 character commit hash.");
    }
    return { type: "commit", sha };
  }
  const number = input.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new Error(
      "reviewTarget.number must be a positive integer for pullRequest.",
    );
  }
  return { type: "pullRequest", number };
}

function usageSummary(snap: SubagentSnapshot) {
  const parts = [
    snap.usage.inputTokens !== undefined
      ? `${formatCompactTokens(snap.usage.inputTokens)} input`
      : "",
    snap.usage.outputTokens !== undefined
      ? `${formatCompactTokens(snap.usage.outputTokens)} output`
      : "",
    snap.usage.costUsd !== undefined ? `$${snap.usage.costUsd.toFixed(4)}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const profile =
    snap.execution.requested.type === "profile"
      ? snap.execution.requested.profile
      : undefined;
  const details = [
    profile ? `profile: ${profile}` : "direct",
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    usageSummary(snap),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full normalized output: ${snap.artifacts.output}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    if (managerPromise) return managerPromise;
    const activeRuntime = getRuntime();
    managerPromise = activeRuntime
      .runPromise(SubagentManager)
      .then(async (manager) => {
        const ctx = sessionContext;
        if (ctx) {
          try {
            await activeRuntime.runPromise(
              manager.restore(ctx.sessionManager.getSessionId(), ctx.cwd),
            );
          } catch (error) {
            ui?.notify(
              `Failed to restore subagent receipts; new runs remain available: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        }
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "failed").length;
    if (running === 0 && failed === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    if (snap.status === "running") return;
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
          artifactPath: fs.existsSync(snap.artifacts.output)
            ? snap.artifacts.output
            : undefined,
        }),
        display: true,
        details: {
          id: snap.id,
          title: snap.title,
          status: snap.status,
          artifactPath: snap.artifacts.output,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "failed" || snap.status === "cancelled"
        ? `by the way “${snap.title}” did not finish — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "failed" || snap.status === "cancelled"
        ? "error"
        : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent-wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    // Rediscover durable receipts on every startup/reload, but never resume
    // work automatically.
    void getManager().catch((error) => {
      ui?.notify(
        `Failed to restore subagent receipts: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    });
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent-spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      profile: Type.Optional(
        StringEnum(PROFILE_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.profile,
        }),
      ),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      workingDir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoningEffort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      reviewTarget: Type.Optional(
        Type.Object({
          type: StringEnum(
            [
              "uncommittedChanges",
              "baseBranch",
              "commit",
              "pullRequest",
            ] as const,
            {
              description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reviewTarget,
            },
          ),
          branch: Type.Optional(Type.String()),
          sha: Type.Optional(Type.String()),
          number: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const directOptionsPresent =
        params.harness !== undefined ||
        params.model !== undefined ||
        params.reasoningEffort !== undefined;
      if (params.profile && directOptionsPresent) {
        throw new Error(
          "profile is mutually exclusive with harness, model, and reasoningEffort.",
        );
      }
      if (!params.profile && !params.harness) {
        throw new Error("Provide either profile or harness.");
      }
      if (params.reviewTarget && params.profile !== "reviewer") {
        throw new Error('reviewTarget is only valid with profile "reviewer".');
      }

      const cwd = path.resolve(ctx.cwd, params.workingDir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`workingDir is not a directory: ${cwd}`);
      }
      const manager = await getManager();

      const parent: ParentContext = {
        parentCwd: ctx.cwd,
        parentSessionId: ctx.sessionManager.getSessionId(),
        projectTrusted: resolveChildProjectTrust({
          parentCwd: ctx.cwd,
          childCwd: cwd,
          parentTrusted: ctx.isProjectTrusted(),
        }),
        inheritedModel: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined,
        inheritedThinkingLevel: pi.getThinkingLevel(),
        modelRegistry: ctx.modelRegistry,
      };
      const title = params.name.trim().slice(0, 160) || "subagent";
      const profile = params.profile;
      const candidates: ReadonlyArray<ExecutionCandidate> = profile
        ? EXECUTION_PROFILES[profile].candidates
        : [
            {
              harness: params.harness!,
              model: params.model,
              reasoningEffort: params.reasoningEffort,
              runMode: "agent",
            },
          ];
      const prompt = profile
        ? buildProfilePrompt(profile, params.prompt)
        : params.prompt;
      const reviewTarget =
        profile === "reviewer"
          ? resolveReviewTarget(params.reviewTarget)
          : undefined;
      const attempts: CandidateAttempt[] = [];
      let snap: SubagentSnapshot | undefined;
      let lastError: Error | undefined;

      for (const [candidateIndex, candidate] of candidates.entries()) {
        const selectedAttempt: CandidateAttempt = {
          ...candidate,
          outcome: "selected",
        };
        try {
          snap = await runTool(
            getRuntime(),
            manager.spawn(candidate.harness, {
              prompt,
              title,
              cwd,
              model: candidate.model,
              reasoningEffort: candidate.reasoningEffort,
              runMode: candidate.runMode,
              reviewTarget,
              execution: {
                requested: profile
                  ? { type: "profile", profile }
                  : { type: "direct" },
                selected: candidate,
                attempts: [...attempts, selectedAttempt],
              },
              fallbackCandidates: profile
                ? candidates.slice(candidateIndex + 1)
                : undefined,
              parent,
            }),
            { signal, interruptMessage: "Subagent spawn aborted." },
          );
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (
            !profile ||
            signal?.aborted ||
            error instanceof ConcurrencyLimitError ||
            (error instanceof SpawnError && error.fallbackAllowed === false)
          ) {
            throw lastError;
          }
          attempts.push({
            ...candidate,
            outcome: "unavailable",
            reason: lastError.message,
          });
        }
      }
      if (!snap) {
        const report = attempts
          .map(
            (attempt) =>
              `${attempt.harness}/${attempt.model ?? "default"}: ${attempt.reason ?? "unavailable"}`,
          )
          .join("; ");
        throw new Error(
          `No execution candidate was available${report ? ` (${report})` : ""}. ${lastError?.message ?? ""}`.trim(),
        );
      }

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness: snap.backend,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
              profile,
              attempts: snap.execution.attempts.length,
              artifactPath: fs.existsSync(snap.artifacts.receipt)
                ? snap.artifacts.output
                : undefined,
              artifactError:
                snap.recovery.reason ??
                "Durable recovery artifacts could not be created.",
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          profile,
          harness: snap.backend,
          model: snap.meta.modelLabel,
          execution: snap.execution,
          artifacts: snap.artifacts,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent-wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
      mode: Type.Optional(
        StringEnum(["all", "any"] as const, {
          description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 2_147_483_647,
          description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.timeoutMs,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const wait = await runTool(
        getRuntime(),
        manager.waitFor(
          ids,
          params.mode ?? "all",
          (pending) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting for ${pending.join(", ")}...`,
                },
              ],
              details: { pending },
            });
          },
          params.timeoutMs,
        ),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      resultDelivery.consume(wait.settledIds);
      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const snap of wait.settledSnapshots) {
        const id = snap.id;
        const verb =
          snap.status === "done"
            ? "finished"
            : snap.status === "cancelled"
              ? "cancelled"
              : "failed";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        section += `\nArtifact: ${snap.artifacts.output}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }
      if (wait.timedOut) {
        sections.push(
          `Wait timed out. Still running: ${wait.pendingIds.join(", ") || "none"}. No subagents were cancelled.`,
        );
      }
      if (sections.length === 0) sections.push("No settled results.");

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          mode: params.mode ?? "all",
          timedOut: wait.timedOut,
          pending: wait.pendingIds,
          results: wait.settledIds.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent-cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent-send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      message: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        throw new Error(`Unknown subagent id "${params.id}".`);
      }
      const message = params.message.trim();
      if (!message) throw new Error("message must not be empty.");
      const receipt = await runTool(
        getRuntime(),
        manager.send(params.id, message),
        { signal, interruptMessage: "Subagent send aborted." },
      );
      return {
        content: [
          {
            type: "text",
            text: `${receipt.id}: ${receipt.disposition} — ${receipt.message}`,
          },
        ],
        details: receipt,
      };
    },
  });

  pi.registerTool({
    name: "subagent-resume",
    label: "Resume Subagent",
    description: SUBAGENT_RESUME_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.id,
      }),
      prompt: Type.String({
        maxLength: 64 * 1024,
        description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.prompt,
      }),
      mode: Type.Optional(
        StringEnum(["auto", "native", "continuation"] as const, {
          description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        throw new Error(`Unknown subagent id "${params.id}".`);
      }
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("prompt must not be empty.");
      const result = await runTool(
        getRuntime(),
        manager.resume(
          params.id,
          prompt,
          {
            parentCwd: ctx.cwd,
            parentSessionId: ctx.sessionManager.getSessionId(),
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: snap.cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
          params.mode ?? "auto",
        ),
        { signal, interruptMessage: "Subagent resume aborted." },
      );
      return {
        content: [
          {
            type: "text",
            text: `Resumed ${params.id} using ${result.mode === "native" ? "the native backend session" : "an artifact-based continuation"}.`,
          },
        ],
        details: {
          id: params.id,
          mode: result.mode,
          status: result.snapshot.status,
          artifacts: result.snapshot.artifacts,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent-check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      const idleSeconds = Math.max(
        0,
        Math.round((Date.now() - snap.lastActivityAt) / 1000),
      );
      let text =
        `${describeSubagent(snap)}\nTurns: ${snap.turns}` +
        `\nLast activity: ${idleSeconds}s ago (${snap.lastEvent})` +
        `\nCurrent tools: ${snap.currentTools.join(", ") || "none"}` +
        `\nUsage: ${usageSummary(snap) || "not reported"}` +
        `\nRecovery: ${snap.recovery.available ? snap.recovery.mode : "not available"}` +
        `\nArtifact: ${snap.artifacts.output}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: {
          id: snap.id,
          status: snap.status,
          turns: snap.turns,
          lastActivityAt: snap.lastActivityAt,
          lastEvent: snap.lastEvent,
          currentTools: snap.currentTools,
          usage: snap.usage,
          recovery: snap.recovery,
          execution: snap.execution,
          artifacts: snap.artifacts,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent-list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const readiness = await runTool(getRuntime(), manager.readiness);
      const backendText = readiness
        .map(
          (entry) =>
            `${entry.backend}: ${entry.ready ? "ready" : "unavailable"} (${entry.detail})`,
        )
        .join("\n");
      const runText =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [
          { type: "text", text: `Backends:\n${backendText}\n\n${runText}` },
        ],
        details: {
          backends: readiness,
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            profile:
              snap.execution.requested.type === "profile"
                ? snap.execution.requested.profile
                : undefined,
            harness: snap.backend,
            model: snap.meta.modelLabel,
            status: snap.status,
            lastActivityAt: snap.lastActivityAt,
            currentTools: snap.currentTools,
            usage: snap.usage,
            recovery: snap.recovery,
            artifacts: snap.artifacts,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed =
        details.status === "failed" || details.status === "cancelled";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const statusLabel =
        details.status === "cancelled"
          ? "cancelled"
          : failed
            ? "failed"
            : "finished";
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg("muted", ` · ${details.title ?? ""} · ${statusLabel}`);

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "failed" || data?.status === "cancelled";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const statusLabel =
        data?.status === "cancelled"
          ? "cancelled"
          : failed
            ? "failed"
            : "answered";
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg("muted", ` · ${statusLabel} · ${data?.id ?? "?"}`);
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            parentSessionId: ctx.sessionManager.getSessionId(),
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent-spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
