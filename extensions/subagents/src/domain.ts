import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export const BACKEND_NAMES = ["pi", "claude", "codex"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export const PROFILE_NAMES = ["scout", "worker", "reviewer", "oracle"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export type SubagentOrigin = "model" | "btw";

export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "failed" | "cancelled";

export type RunMode = "agent" | "review" | "code-review";

export type ReviewTarget =
  | { readonly type: "uncommittedChanges" }
  | { readonly type: "baseBranch"; readonly branch: string }
  | { readonly type: "commit"; readonly sha: string }
  | { readonly type: "pullRequest"; readonly number: number };

export interface ParentContext {
  readonly parentCwd: string;
  readonly parentSessionId?: string;
  readonly projectTrusted: boolean;
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  readonly modelRegistry?: ModelRegistry;
}

export interface ExecutionCandidate {
  readonly harness: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly runMode: RunMode;
}

export interface CandidateAttempt extends ExecutionCandidate {
  readonly outcome: "selected" | "unavailable";
  readonly reason?: string;
}

export interface ExecutionSelection {
  readonly requested:
    | { readonly type: "profile"; readonly profile: ProfileName }
    | { readonly type: "direct" };
  readonly selected: ExecutionCandidate;
  readonly attempts: ReadonlyArray<CandidateAttempt>;
}

export interface ResumeSource {
  readonly mode: "native" | "continuation";
  readonly nativeSessionId?: string;
  readonly sessionFilePath?: string;
  readonly previousOutput?: string;
}

export interface SpawnTask {
  readonly origin?: SubagentOrigin;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly runMode?: RunMode;
  readonly reviewTarget?: ReviewTarget;
  readonly execution?: ExecutionSelection;
  /** Remaining declared profile candidates available for pre-activity fallback. */
  readonly fallbackCandidates?: ReadonlyArray<ExecutionCandidate>;
  readonly resume?: ResumeSource;
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  readonly modelLabel?: string;
  readonly contextWindow?: number;
  readonly sessionFilePath?: string;
  readonly nativeSessionId?: string;
}

export interface SubagentUsage {
  /** Current context occupancy, not cumulative input spend. */
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export interface ArtifactPaths {
  readonly directory: string;
  readonly receipt: string;
  readonly snapshot: string;
  readonly transcript: string;
  readonly output: string;
}

export interface RecoveryState {
  readonly available: boolean;
  readonly mode?: "native" | "continuation";
  readonly reason?: string;
}

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

export type SubagentEvent =
  | { readonly _tag: "RunStarted" }
  | {
      /** Typed backend rejection before a model response or tool execution. */
      readonly _tag: "RunRejected";
      readonly reason: string;
      readonly message: string;
    }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | { readonly _tag: "UsageChanged"; readonly usage: Partial<SubagentUsage> }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  | { readonly _tag: "BackendError"; readonly message: string };

export interface SubagentSnapshot {
  readonly id: string;
  readonly origin: SubagentOrigin;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly parentCwd: string;
  readonly parentSessionId?: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly lastEvent: SubagentEvent["_tag"] | "Recovered";
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: SubagentUsage;
  readonly execution: ExecutionSelection;
  readonly reviewTarget?: ReviewTarget;
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly currentTools: ReadonlyArray<string>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  readonly finalText: string;
  readonly turns: number;
  readonly artifacts: ArtifactPaths;
  readonly recovery: RecoveryState;
}

export interface SendReceipt {
  readonly id: string;
  readonly disposition: "delivered" | "queued" | "unsupported";
  readonly receiptAt: number;
  readonly message: string;
}

export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  if (snap.finalText.trim()) return snap.finalText;
  for (let index = snap.transcript.length - 1; index >= 0; index--) {
    const item = snap.transcript[index];
    if (item?.kind !== "assistant") continue;
    const text = item.parts
      .filter(
        (part): part is Extract<TranscriptPart, { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
  /** False only for manager lifecycle failures that another backend cannot fix. */
  readonly fallbackAllowed?: boolean;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}

export class ResumeError extends Data.TaggedError("ResumeError")<{
  readonly message: string;
}> {}
