import type {
  ExecutionCandidate,
  ProfileName,
  ReviewTarget,
} from "./domain.ts";

export interface ExecutionProfile {
  readonly description: string;
  readonly candidates: ReadonlyArray<ExecutionCandidate>;
  readonly promptPrefix: string;
}

export const EXECUTION_PROFILES = {
  scout: {
    description: "Inspect a codebase and return a concise evidence map",
    promptPrefix:
      "Act as a repository scout. Inspect and report only: do not edit files or mutate the workspace. Cite concrete paths and distinguish verified facts from uncertainty.",
    candidates: [
      {
        harness: "pi",
        model: "openai-codex/gpt-5.6-luna",
        reasoningEffort: "xhigh",
        runMode: "agent",
      },
      {
        harness: "pi",
        model: "opencode-go/deepseek-v4-pro",
        reasoningEffort: "high",
        runMode: "agent",
      },
    ],
  },
  worker: {
    description: "Implement a focused engineering task",
    promptPrefix:
      "Act as an implementation worker. Make the requested changes in the assigned working directory, keep the work focused, validate it, and report changed paths and checks run.",
    candidates: [
      {
        harness: "claude",
        model: "claude-fable-5",
        reasoningEffort: "medium",
        runMode: "agent",
      },
      {
        harness: "pi",
        model: "opencode-go/kimi-k3",
        reasoningEffort: "max",
        runMode: "agent",
      },
      {
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningEffort: "high",
        runMode: "agent",
      },
    ],
  },
  reviewer: {
    description: "Review changes for concrete, actionable defects",
    promptPrefix:
      "Review the selected changes. Prioritize correctness, security, regressions, and violated repository constraints. Report only actionable findings with path and line evidence; avoid style nitpicks and do not modify files or post remote comments.",
    candidates: [
      {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        runMode: "review",
      },
      {
        harness: "claude",
        model: "claude-fable-5",
        reasoningEffort: "high",
        runMode: "code-review",
      },
    ],
  },
  oracle: {
    description: "Analyze a difficult technical decision or failure",
    promptPrefix:
      "Act as a technical oracle. Inspect the available evidence, reason deeply about the question, identify trade-offs and uncertainty, and recommend a concrete course of action. Do not modify files unless the task explicitly requests implementation.",
    candidates: [
      {
        harness: "claude",
        model: "claude-fable-5",
        reasoningEffort: "high",
        runMode: "agent",
      },
      {
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningEffort: "high",
        runMode: "agent",
      },
    ],
  },
} as const satisfies Record<ProfileName, ExecutionProfile>;

export function buildProfilePrompt(profile: ProfileName, task: string) {
  return `${EXECUTION_PROFILES[profile].promptPrefix}\n\nTask:\n${task.trim()}`;
}

export function defaultReviewTarget(): ReviewTarget {
  return { type: "uncommittedChanges" };
}
